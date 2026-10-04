# Design

## Decisión 1 — Dónde vive una cámara cargada desde el softphone

Al agregarla se elige el destino, y se elige una vez:

| Destino | Qué pasa | Para qué sirve |
|---|---|---|
| **En la central** | Se crea la fila en `pbxng_client_devices`, la central publica la fuente en su go2rtc y devuelve el `go2rtc_src`. El softphone la ve después por el mismo camino que cualquier otra cámara. | La cámara de un cliente real, que todos los que atienden tienen que poder ver. |
| **Sólo en este teléfono** | Queda en el almacén cifrado local, con su URL RTSP tal cual. No se manda a ningún lado. | Una obra en curso, una prueba, un cliente que todavía no está en el CRM, o un softphone que no está conectado a ninguna central. |

Lo elegido se puede cambiar después: «subir a la central» y «bajar a este teléfono» son dos
acciones, nunca automáticas. La razón de que no haya sincronización automática es simple:
una URL RTSP trae usuario y contraseña de la cámara adentro, y subirla sin que nadie lo pida
la hace visible a todos los que atienden en esa central.

## Decisión 2 — Cómo se ve una cámara que está sólo en el teléfono (ABIERTA)

Chromium no reproduce `rtsp://`. Hoy TODO el video de cámaras del producto pasa por el
go2rtc de la central, que es exactamente lo que no hay en el caso local. Tres caminos:

**(a) Empacar go2rtc en el softphone de escritorio.** Un binario estático (~15 MB, MIT) que
el Electron levanta en `127.0.0.1` y usa igual que al de la central. Es el mismo motor que
ya corre en el producto, así que no hay un segundo comportamiento que mantener, y funciona
sin red hacia la central. Cuesta tamaño de instalador y un proceso hijo que hay que
apagar bien al cerrar. En Android no aplica.

**(b) Apuntar a un go2rtc propio.** En Ajustes se pone la URL de un go2rtc/MediaMTX que el
usuario ya tenga, y las cámaras locales se publican ahí. Cero peso en el instalador, pero
le pide al usuario infraestructura que probablemente no tiene.

**(c) Sólo snapshot.** Muchos porteros y cámaras (Hikvision, Dahua, Akuvox) además del RTSP
exponen un JPEG por HTTP. Sin central se muestra una imagen que se refresca cada segundo en
vez de video. Es lo más barato y lo único que puede andar en Android, pero depende del
fabricante y no es video.

**Recomendación:** (a) en escritorio y (c) como caída en Android, dejando «subirla a la
central» como el camino completo en los dos. Se decide antes del grupo 3 de tareas; los
grupos 1 y 2 (almacenamiento y alta) no dependen de esto.

## Decisión 3 — Cómo se mezclan los clientes del sistema con los locales

Una sola lista, ordenada por nombre, con el origen marcado en cada fila. Reglas:

- Un cliente local **nunca** se sube solo.
- La búsqueda de la ficha durante la llamada mira las dos fuentes. Si el número aparece en
  las dos, gana el del sistema: es el dato que mantiene quien administra la central, y el
  local es una anotación personal.
- Las cámaras que entran a la pantalla de la llamada son la unión de las dos, las del
  sistema primero. Se marcan igual que en la lista, para que nadie se confunda sobre por
  qué un compañero no ve la misma cámara.
- Al cambiar de cuenta (`switchAccount`) los clientes locales **no** se borran: son del
  aparato, no de la cuenta. Esto es a propósito y es distinto de `cls`/`clsFull`, que sí se
  limpian porque son de la central.

## Decisión 4 — Qué se abre en el token de aparato

El token de enrolado (`scope: 'phone'`) es deliberadamente chico: quien tenga el QR tiene
sólo eso. Se agrega lo mínimo:

- `GET /api/clients/:id` — el detalle que la solapa Clientes ya pide y hoy come un 403.
- `POST /api/clients/:id/devices` y `DELETE /api/clients/:id/devices/:did` — el alta y la
  baja de un dispositivo.

Lo que NO se abre: crear o borrar clientes del sistema, editar personas o espacios, ni
tocar dispositivos de otro cliente que el de la ruta. Un softphone que quiera crear un
cliente del sistema tiene que iniciar sesión con usuario del panel; si no, lo crea local.

Queda anotado el riesgo que esto sí abre: con el QR de un interno se puede agregar una
cámara a un cliente existente. Es menos grave que leer la central entera, pero no es nada:
por eso el alta queda en la bitácora de seguridad con la extensión que la hizo.
