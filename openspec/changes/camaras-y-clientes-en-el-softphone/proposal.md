# Proposal

## Why

Hoy el softphone sólo ve clientes y cámaras si la central se los presta, y nunca puede
agregar ni uno. Eso deja tres agujeros que se ven en el uso real:

1. **El que no está conectado al sistema no tiene nada.** El softphone arranca con el
   enrolado (QR / link) y queda con un token de aparato; si además no se inició sesión con
   usuario del panel, la solapa Clientes ni aparece. Un técnico que anda con el softphone y
   quiere tener a mano los porteros de tres obras no tiene dónde anotarlos.
2. **El que SÍ está conectado tampoco los ve completos.** `GET /api/clients/:id` no está
   en la allowlist del token de aparato (`FONO_PERMITIDO`), así que la lista de clientes
   carga pero al abrir uno la ficha vuelve 403 y la pestaña de dispositivos dice «Sin
   dispositivos» aunque el cliente tenga cámaras cargadas. Esto es, literalmente, «al
   loguearte no te trae clientes».
3. **No hay forma de agregar una cámara desde el teléfono.** Las cámaras se cargan sólo
   desde el panel, en `pbxng_client_devices`, y el softphone las consume ya publicadas en
   el go2rtc de la central. Quien está en la obra, con la URL RTSP del portero en la mano,
   tiene que pedirle a otro que la cargue.

## What Changes

- El softphone puede **agregar una cámara RTSP a mano**, asociada a un cliente, eligiendo
  dónde queda: **en la central** (la ve todo el mundo, el video sale por el go2rtc de la
  central como cualquier otra) o **sólo en este teléfono** (no se comparte, no sale del
  aparato).
- El softphone tiene **clientes propios**, guardados localmente y cifrados con el mismo
  almacén que ya guarda las cuentas SIP. Existen con o sin central, y sobreviven al cierre
  de la app, a la actualización y al cambio de cuenta.
- Cuando hay central conectada, la lista de clientes es **una sola** con los del sistema y
  los locales, cada uno marcado con su origen. Un cliente local nunca se sube solo: subirlo
  es una acción explícita.
- La **ficha durante la llamada** busca el número entrante en los dos lados, y las cámaras
  que aparecen en pantalla pueden ser del sistema o locales, indistintamente.
- Se arregla el 403 de `GET /api/clients/:id` para el token de aparato, y se abren los tres
  verbos de escritura de dispositivos que necesita el alta — acotados a lo que el aparato
  puede tocar.
- **BREAKING** no hay. Un softphone que nunca agregue nada se comporta igual que hoy.

## Capabilities

### New Capabilities

- `camaras-y-clientes-del-softphone` — de dónde salen los clientes y las cámaras que ve un
  softphone, dónde se guardan los que él mismo carga, y qué se puede ver sin central.

## Impact

- `softphone-app/src/config.js` — el almacén cifrado pasa de `{ config, accounts }` a
  `{ config, accounts, clientes }`, con migración al vuelo.
- `softphone-app/src/App.jsx` — lista de clientes unificada, alta de cliente y de cámara,
  `camaras` de la llamada sale de las dos fuentes.
- `softphone-app/src/api.js` — alta/baja de dispositivo, y el detalle de cliente.
- `control-plane/auth.js` — `FONO_PERMITIDO`: alta el detalle de cliente y la escritura de
  dispositivos acotada.
- `control-plane/app.js` — el alta de dispositivo acepta una URL RTSP y la publica en
  go2rtc (hoy el panel ya hace eso; se comparte el camino, no se duplica).
- Sin migración de base de datos: una cámara que se manda a la central es una fila normal
  de `pbxng_client_devices`.

## Open decision

**Cómo se ve un video RTSP sin central.** Chromium no reproduce RTSP, así que una cámara
guardada sólo en el teléfono se puede anotar pero no mirar sin algo que la convierta. Ver
`design.md`; el alta y el almacenamiento no dependen de esta decisión y se pueden hacer
antes.
