# Proposal

## Why

Una llamada entrante y una saliente se comportan distinto, y la diferencia aparece justo en
el momento que más importa. Cuando llama el portero de un cliente, mientras timbra no se ve
ninguna de sus cámaras: se ve un orbe y el nombre. Recién al atender aparece la imagen de la
entrada. Pero atender es exactamente la decisión que uno quiere tomar DESPUÉS de mirar quién
está en la puerta.

En el código la asimetría está escrita en una línea (`App.jsx`): las cámaras del cliente se
excluyen a propósito mientras la llamada es entrante. En una saliente se ven desde que
empieza a timbrar del otro lado.

## What Changes

- Las cámaras del cliente se ven **mientras timbra** una llamada entrante, con el mismo
  comportamiento que ya tienen durante la llamada: una grande y el resto en miniaturas, y se
  cambia de una a otra con un clic.
- Atender, rechazar y atender con video pasan a estar **sobre el video**. Hoy viven en el
  bloque central, que se oculta entero cuando hay escena de video: encender las cámaras al
  timbrar sin mover esos botones dejaría una llamada que se ve pero no se puede atender.
- La ficha del CRM y el nombre de quien llama también se muestran sobre el video, por el
  mismo motivo.
- La miniatura con la cámara propia se enciende **desde el timbrado**, no al atender.
- Si la llamada entrante ya anuncia video, las cámaras del cliente no se encienden mientras
  timbra: la imagen que importa es la que va a traer la llamada.

## Capabilities

### New Capabilities

- `video-en-llamada` — qué imagen muestra el softphone en cada momento de una llamada, de
  dónde sale, y qué controles tiene que haber a la vista encima.

### Modified Capabilities

Ninguna: `openspec/specs/` todavía está vacío.

## Impact

- `softphone-app/src/App.jsx` — la regla de cuándo hay cámaras y cuál es la fuente principal.
- `softphone-app/src/CallScreen.jsx` — los controles del estado entrante sobre el video.
- `softphone-app/src/useSip.js` y `useSipNative.js` — la cámara propia antes de atender no
  existe hoy: el stream local recién se crea cuando la sesión tiene medios. Hace falta una
  previa, y hay que entregarle esa misma pista a la sesión al aceptar.
- Permisos y hardware: la cámara se enciende en llamadas que todavía no se aceptaron.
