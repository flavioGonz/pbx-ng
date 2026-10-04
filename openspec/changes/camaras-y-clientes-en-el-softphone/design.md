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

## Decisión 2 — Cómo se ve una cámara que está sólo en el teléfono — CERRADA

**El softphone de escritorio trae su propio go2rtc.** Un binario estático de ~15 MB
(`go2rtc_win64`, MIT) que viaja en el instalador como recurso y se levanta en `127.0.0.1`
cuando hace falta. Es el **mismo motor** que corre en la central, así que una cámara local
se ve por el mismo camino que una de la central —el proxy WebSocket del proceso main, MSE
en el renderer, el mismo visor— y no hay un segundo reproductor que mantener.

Las otras dos opciones quedan descartadas: apuntar a un go2rtc del propio usuario le pide
infraestructura que no tiene, y el snapshot JPEG depende del fabricante y no es video.

### Lo que no se ve en el camino feliz

- **Por demanda, no al arrancar.** Casi ningún uso del softphone toca una cámara local;
  dejar un proceso hijo corriendo para nada cuesta memoria y es un puerto más, aunque sea
  en loopback.
- **Puerto efímero pedido al sistema.** Fijar el 1984 —el de go2rtc— choca con un go2rtc
  que el usuario ya tenga corriendo, o con una segunda instancia del softphone.
- **Sólo `127.0.0.1`.** Un go2rtc en `0.0.0.0` publica en la red de la oficina, sin
  autenticación, las cámaras del cliente con sus credenciales dentro de la URL. Es el
  punto donde esto pasa de útil a peligroso, no un detalle de configuración. Verificado
  contra la IP real de la máquina: conexión rechazada.
- **El config se escribe con permisos 600**, y el `stderr` de go2rtc va al log de la app y
  nunca a la pantalla: las dos cosas llevan la URL con usuario y clave adentro.
- **No se pide «entrada» (ticket) para una cámara local.** Es loopback y no hay sesión de
  central; pedírselo a la central además mandaría el nombre de una cámara local a un
  servidor que no la conoce.
- **El hijo se mata en `before-quit`**, no sólo en `will-quit`: un go2rtc huérfano sigue
  tirándole RTSP a las cámaras del cliente después de cerrar la app.
- **El binario no se baja en caliente.** Si no está, se dice y se ofrece subir la cámara a
  la central. Una app de escritorio que sale a buscar un ejecutable a internet y lo corre
  es exactamente la forma de un troyano, y el usuario no tiene cómo distinguirlo.
- **No está commiteado**: 15 MB de binario de terceros por plataforma engordan cada clon
  para siempre. Lo baja `scripts/fetch-go2rtc.sh` en el build, con la versión fijada y el
  SHA-256 escrito al lado — que es lo único que permite decir después qué binario se
  metió en un instalador ya distribuido.

### Límite conocido

go2rtc repacka H.264 a MSE sin ayuda de nadie, y eso es lo que hace la inmensa mayoría de
las cámaras y porteros. Lo que **necesita ffmpeg** —que NO viaja en el instalador— es
transcodificar: una cámara que sólo emita H.265, o audio en un códec que el navegador no
toca. En esos casos el visor dice que no puede, igual que hoy. Agregar ffmpeg son ~80 MB
más de instalador y no se paga por adelantado por un caso que todavía no apareció.

### La PWA no tiene esto

En el navegador no hay proceso hijo que levantar. La cámara local se guarda y se lista, y
el visor dice que para verla hace falta el softphone de escritorio, o subirla a la central.
Es una diferencia real entre los dos y conviene que se lea en la pantalla, no que quede en
un reproductor que no arranca nunca.

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
