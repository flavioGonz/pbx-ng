# Manual de la App de Escritorio (Windows)

> **Para quién es este manual**
> Para quien va a usar el **PBX-NG Softphone** en una PC con Windows, y para el
> administrador que lo instala y lo mantiene en la empresa. La app es el mismo teléfono que
> corre en el navegador y en el celular, pero **empaquetado como programa de Windows**: se
> instala con un `.exe`, vive en la bandeja del sistema, suena aunque esté minimizada, tiene
> atajos de teclado globales y una ventana flotante para tenerla siempre a la vista.

La app se llama **PBX-NG Softphone**. Es la opción que conviene a quien pasa el día llamando:
recepción, ventas, soporte, un puesto de operador. Si sólo llamás de vez en cuando, con el
teléfono del navegador alcanza; si el teléfono es tu herramienta principal, la app de
escritorio te da lo que el navegador no puede (timbre en segundo plano, atajos globales,
click-to-call desde otras aplicaciones, arranque con Windows).

---

## 1. Cuándo conviene la app de escritorio

| | Navegador | Celular (PWA) | **App de escritorio (Windows)** |
|---|---|---|---|
| Instalar algo | No | Se agrega a la pantalla de inicio | Sí, un `.exe` |
| Suena si está minimizada / en segundo plano | Limitado | Limitado (iOS) | **Sí, siempre** |
| Atajos de teclado globales | No | No | **Sí (atender/colgar/silenciar)** |
| Ventana flotante siempre visible | No | No | **Sí (modo mini)** |
| Arranca solo con la PC | No | No | **Sí (iniciar con Windows)** |
| Click-to-call desde el CRM / navegador | No | No | **Sí (`tel:` / `sip:` / `callto:`)** |
| Se actualiza sola | Recargando la web | Sola | **Sí (auto-update)** |

La app y el navegador **no pelean**: podés tener las dos, con la misma extensión, al mismo
tiempo. La central entrega la llamada al que esté disponible.

---

## 2. Requisitos

- **Windows 10 o Windows 11**, 64 bits. (No hay build de 32 bits.)
- **Micrófono** — cualquier auricular USB o el del notebook. Para video, una cámara.
- **Salida a Internet** hacia tu central o hacia el borde SBC. La app tolera estar detrás
  de NAT y de casi cualquier router; para eso usa STUN/TURN (ver §4.5).
- **Permisos de instalación**: el `.exe` se instala por usuario y **no pide administrador**.
  El `.msi` (despliegue corporativo) sí instala para toda la máquina y requiere admin.

> La app pesa poco y consume poco: en reposo es una pestaña de bandeja. El grueso del trabajo
> (audio, cifrado) sólo ocurre durante la llamada.

---

## 3. Instalación

Hay tres formas de poner la app, según el escenario. Para un usuario suelto, el `.exe`. Para
una flota de PCs administradas, el `.msi`. Y si no querés instalar nada, la versión portable.

### 3.1 Instalador individual (`.exe`)

Es el camino normal. El administrador te pasa un archivo llamado
`PBX-NG-Softphone-Setup-x.y.z.exe` (donde `x.y.z` es la versión).

1. Doble clic en el `.exe`.
2. El instalador está **en español**. Te deja **elegir la carpeta** de instalación si querés,
   o dejar la que propone.
3. Crea **acceso directo en el escritorio** y en el **menú Inicio**.
4. Al terminar, la app arranca sola.

![Instalador del softphone en español, eligiendo carpeta](img/sfd-01-instalador.png)

> **No pide permisos de administrador.** Se instala dentro de tu perfil de usuario. Por eso
> cualquiera puede instalarlo en su PC sin depender de IT.

### 3.2 Despliegue en la empresa (`.msi`)

Para instalar en muchas PCs a la vez, el administrador usa el instalador **`.msi`**
(`PBX-NG-Softphone-x.y.z.msi`). A diferencia del `.exe`, el `.msi`:

- Instala **para toda la máquina** (per-machine), no por usuario.
- Se despliega en silencio por **GPO (Directiva de grupo)**, **Microsoft Intune** o **SCCM**.
- Es lo que se usa cuando IT quiere que la app aparezca sola en el parque de equipos.

Instalación silenciosa típica desde una consola con permisos:

```
msiexec /i "PBX-NG-Softphone-x.y.z.msi" /qn
```

> El `.msi` **no** arranca la app al terminar (a diferencia del `.exe`), justamente para no
> molestar durante un despliegue masivo.

### 3.3 Versión portable (sin instalar)

Si no querés (o no podés) instalar, existe la carpeta **`win-unpacked`** con el ejecutable
`PBX-NG Softphone.exe` adentro: corre tal cual, sin instalación, desde un pendrive o una
carpeta. No trae auto-update ni accesos directos, pero es idéntica por dentro.

### 3.4 Primer arranque

La primera vez vas a ver una **pantalla de bienvenida** (splash) mientras la app carga, y
después la pantalla de acceso. Windows puede preguntarte por el **permiso del micrófono** (y
de la cámara, si vas a hacer video): aceptá, si no, no te van a escuchar.

![Pantalla de bienvenida al abrir la app](img/sfd-02-splash.png)

---

## 4. Configurar tu cuenta

### 4.1 Con el QR o el enlace (lo normal)

El administrador te manda un **correo con un código QR** y un enlace. Con eso la app se
configura sola: no anotás contraseñas ni servidores.

1. Abrí la app y tocá el **botón de QR**, arriba a la derecha del título *"Conectar a tu
   central"*.
2. En una PC (sin cámara) elegí **"Pegar código"** y pegá el enlace del correo.
3. La app detecta sola si tu extensión es **WebRTC** o **SIP**, se configura y queda en línea.

![Pegar el código de aprovisionamiento](img/sfd-03-qr.png)

> **Enlace `pbxng://`** — el correo puede traer un enlace que empieza con `pbxng://`. Si hacés
> clic desde la misma PC, Windows abre la app y la configura de una: la app se registra como
> dueña de ese tipo de enlace al instalarse.

> El acceso del correo **vence en 24 horas**. Si se te venció, pedile al administrador uno nuevo.

### 4.2 A mano: modo WebRTC

Es el modo habitual: el teléfono habla con la central **por Internet**, cifrado, sin abrir
puertos en tu red. Anda desde casa, desde una sucursal, detrás de casi cualquier router.

| Campo | Qué poner | Ejemplo |
|---|---|---|
| **Servidor WebSocket (WSS)** | La dirección que te dio el administrador | `wss://pbx.tu-empresa.com/ws` |
| **Servidor WSS de respaldo** *(opcional)* | Un segundo WSS por si el primero cae | `wss://pbx2.tu-empresa.com/ws` |
| **Dominio SIP** | Suele ser el mismo dominio, sin `wss://` | `pbx.tu-empresa.com` |
| **Extensión / usuario** | Tu número | `2001` |
| **Contraseña** | La de tu extensión | — |
| **Nombre para mostrar** *(opcional)* | Cómo te ven los demás | `Recepción` |

![Configuración en modo WebRTC](img/sfd-04-webrtc.png)

### 4.3 A mano: modo SIP nativo

Es el modo clásico, el de los teléfonos de escritorio. La app trae un **motor SIP propio**
que habla **UDP, TCP o TLS** directo contra la central (no necesita WebSocket). Se usa cuando
la central **no expone WebRTC**, cuando estás dentro de la red de la empresa, o cuando te
registrás como **extensión SIP a través del borde SBC**.

| Campo | Qué poner | Ejemplo |
|---|---|---|
| **Servidor SIP** | Host o IP de la central / del borde | `192.168.1.10` |
| **Puerto** | 5060 para UDP/TCP, 5061 para TLS | `5060` |
| **Transporte** | UDP, TCP o TLS | `UDP` |
| **Dominio SIP** | El dominio de la central | `pbx.tu-empresa.com` |
| **Extensión y contraseña** | Los tuyos | `2001` |

Opciones avanzadas del modo SIP nativo:

| Opción | Para qué |
|---|---|
| **SRTP** | Cifra el audio (`none` / `sdes` / obligatorio). Si la central lo exige, activalo. |
| **DTMF** | Cómo se mandan los tonos del teclado: `RFC 4733` (recomendado) o `inband`. |
| **Verificar TLS** | Valida el certificado del servidor. Desactivalo sólo con certificados internos. |
| **Buscar por SRV (DNS)** | Deja que el DNS resuelva el servidor SIP por registros `_sip._udp`. |
| **MWI** | Aviso de mensajes en espera (se enciende el ícono del buzón cuando hay uno). |

![Configuración en modo SIP nativo con opciones avanzadas](img/sfd-05-sip.png)

> **¿Cuál te toca?** No adivines. Si el administrador te mandó el enlace, la app resuelve el
> modo sola. Una extensión **WebRTC no funciona** en modo SIP nativo (la central le exige
> cifrado y el audio no levanta), y una extensión SIP clásica **no tiene WebSocket** al que
> conectarse.

### 4.4 Códecs de audio

» En la app: **Ajustes → Registro → Códec de audio**

Es el mismo selector en los dos modos, pero **las opciones cambian** según el transporte,
porque no ambos pueden hacer lo mismo:

| Modo | Opciones disponibles | Por qué |
|---|---|---|
| **WebRTC** | Automático · Opus · G.722 · G.711 µ · G.711 A | El audio lo maneja el motor del navegador, que sabe todos esos códecs |
| **SIP nativo** | Automático · G.711 µ · G.711 A | El motor nativo codifica **sólo G.711**. Ofrecer Opus sería mentir: no lo podría codificar |

- **Automático** (por defecto): se ofrecen todos los que la app soporta y elige el otro extremo.
  Es lo correcto casi siempre.
- **Elegir uno**: en SIP nativo se ofrece **sólo ese** (µ-law o A-law). En WebRTC se ofrece
  primero, y con la casilla **Forzar** se descartan los demás.
- **Forzar** (sólo WebRTC): sirve para **probar el transcoding** del borde — poné Opus acá, y si
  el operador habla G.711, el SBC transcodifica en el medio y lo ves en su pantalla *Transcoding*.

> **Cuidado al forzar.** Si el otro extremo no soporta el códec que forzaste, la llamada conecta
> pero **no arma audio**. Es una herramienta de prueba, no una configuración para dejar puesta.

> **µ-law o A-law.** En América se usa **µ-law (PCMU)** y en Europa **A-law (PCMA)**. Con
> *Automático* no tenés que acordarte: se ofrecen los dos.

![Selector de códec en Ajustes](img/sfd-06-codec.png)

### 4.4.1 Video: qué modo lo soporta

No es lo mismo según cómo estés registrado, y conviene saberlo antes de prometerle video a un
cliente:

| | **WebRTC** | **SIP nativo** |
|---|---|---|
| Video | ✅ Sí | ✅ Sí (H.264) |
| Audio de banda ancha (Opus / G.722) | ✅ Sí | ❌ Sólo G.711 |
| Cómo se inicia | Botón de cámara al llamar, o encenderla en la llamada | Botón de cámara **al llamar**: se negocia al inicio |

En **modo nativo**, el video se decide **cuando arranca la llamada**: usás el botón de cámara del
marcador, o atendés una entrante con el botón de video. No se puede "encender la cámara" a mitad
de una llamada que empezó como audio (eso requiere renegociar la sesión, y hoy no está).

Para recibir una videollamada, el otro extremo también tiene que ofrecer video: si te llaman en
audio, la llamada es de audio aunque tengas cámara.

> **Si el video no arranca en modo nativo**, mirá primero que el otro extremo realmente esté
> ofreciendo video, y después que la central tenga habilitado el video en ese interno. En el
> panel de diagnóstico de la app se ve el códec real que quedó negociado.

### 4.5 STUN y TURN (para que haya audio detrás de NAT)

El audio de una llamada viaja aparte de la señalización, y detrás de NAT a veces no encuentra
el camino (la llamada conecta pero **no se escucha**). Para resolverlo:

- **STUN** le dice a la app cuál es su IP pública. Viene uno público configurado por defecto.
- **TURN** es un relay: cuando el audio directo no es posible, pasa por ahí. Lo da el
  administrador con su usuario y clave.

Durante la llamada, una etiqueta te dice por dónde va el audio: **DIRECTO** (peer-to-peer) o
**VÍA TURN** (relay). Es informativa; si tenés cortes, ese dato le sirve al administrador.

### 4.6 Varias cuentas

La app guarda **varias cuentas** y te deja cambiar de una a otra sin recargar los datos cada
vez (por ejemplo, tu interno personal y el de un puesto compartido). Se administran desde el
selector de cuentas en la pantalla de acceso.

### 4.7 Dónde se guardan tus datos (cifrado)

En la app de escritorio, tu configuración y tu contraseña se guardan **cifradas con DPAPI de
Windows** (el mismo mecanismo que usa el navegador para tus claves): quedan atadas a tu usuario
de Windows y no se pueden leer desde otra cuenta ni copiando el archivo a otra PC. En el
navegador, en cambio, caen a almacenamiento local sin ese cifrado — otra razón para preferir la
app de escritorio en un puesto fijo.

---

## 5. El día a día

### 5.1 Llamar

Marcá el número en el teclado y tocá el botón verde. También podés **escribir el nombre** de
un compañero: aparece solo mientras tipeás. Tus **favoritos** y tu **historial** quedan a mano.

![Marcador y búsqueda de contactos](img/sfd-07-marcador.png)

### 5.2 Recibir

Cuando te llaman, la app **suena y salta al frente**, y Windows te muestra una **notificación**
aunque estés en otra aplicación. Si el número está en el sistema de clientes, ves **su ficha**
antes de atender. Atendés con el verde, rechazás con el rojo.

### 5.3 Durante la llamada

| Botón | Qué hace |
|---|---|
| **Silenciar** | El otro deja de escucharte; vos lo seguís escuchando. |
| **Teclado** | Manda tonos DTMF ("marque 1 para…"). |
| **Retener** | Deja a la persona en espera con música. |
| **Transferir** | Le pasás la llamada a otra extensión. |
| **Video** | Encendés la cámara. |
| **Invitar** | Sumás a otra persona a la conversación. |
| **Grabar** | Empieza a grabar la llamada. |
| **Volumen** | Ajustás cuánto escuchás al otro lado. |

![Pantalla de llamada en curso](img/sfd-08-en-llamada.png)

### 5.4 Elegir micrófono, altavoz y cámara

En **Ajustes → Dispositivos** elegís qué micrófono, qué altavoz y qué cámara usa la app. Útil
cuando tenés varios (el del notebook y un auricular USB). La app se acuerda de tu elección.

---

## 6. La ventana flotante (modo mini)

Tocá el botón **mini** en la barra superior y el teléfono se encoge a una **ventanita chica que
queda siempre arriba de todo**, aunque estés trabajando en otra aplicación. Desde ahí atendés,
silenciás, cortás y controlás el volumen sin volver a la ventana grande. Cuando entra una
llamada, la ventanita **vibra** para llamarte la atención.

![La ventana flotante siempre visible](img/sfd-09-mini.png)

---

## 7. Bandeja del sistema y arranque con Windows

Cuando cerrás la ventana con la **X**, la app **no se cierra**: se esconde en la **bandeja del
sistema** (al lado del reloj) y sigue registrada, lista para recibir. Es a propósito: un
softphone tiene que estar disponible aunque no lo tengas en pantalla.

Clic derecho en el ícono de la bandeja:

- **Abrir** — trae la ventana de vuelta.
- **Iniciar con Windows** — la app arranca sola al prender la PC, **minimizada en la bandeja**,
  ya registrada. Ideal para un puesto de trabajo.
- **Salir** — cierra la app de verdad.

![Menú de la bandeja del sistema](img/sfd-10-bandeja.png)

---

## 8. Atajos de teclado globales

La app registra **atajos que funcionan desde cualquier aplicación**, incluso sin la ventana al
frente. Sirven para atender sin buscar la ventana cuando estás escribiendo un mail o en el CRM:

| Atajo | Acción |
|---|---|
| **Ctrl + Shift + A** | Atender la llamada entrante |
| **Ctrl + Shift + H** | Colgar (o rechazar la entrante) |
| **Ctrl + Shift + M** | Silenciar / reactivar el micrófono |

---

## 9. Click-to-call desde otras aplicaciones

La app se registra como manejadora de los enlaces **`tel:`**, **`sip:`** y **`callto:`**. En la
práctica: si en tu CRM, en una planilla o en una página web hacés clic en un número de teléfono,
**Windows abre el softphone y marca solo**. No hay que copiar y pegar.

También funciona desde la línea de comandos o un acceso directo:

```
start tel:099123456
```

---

## 10. Notificaciones y re-registro automático

- **Notificaciones de Windows** cuando entra una llamada (con quién es), aunque la app esté en
  la bandeja.
- **Re-registro automático**: cuando la PC **vuelve de suspensión**, **se desbloquea la sesión**
  o **vuelve la red**, la app se re-registra sola. No tenés que reconectar a mano después de
  levantar la notebook.

---

## 11. Actualizaciones automáticas

La app **se actualiza sola**. Al abrirla, chequea si hay una versión nueva; si la hay, la
descarga en segundo plano y te avisa para instalarla (se aplica al reiniciar la app). No tenés
que volver a bajar el instalador cada vez.

> El administrador publica las versiones nuevas; a los usuarios les llegan solas.

---

## 12. Problemas frecuentes

» Ajustes → Dispositivos  ·  Ajustes → Diagnóstico

| Qué te pasa | Qué hacer |
|---|---|
| Dice **"sin conectar"** | Fijate que tengas Internet. La app muestra **el motivo real** del fallo abajo del estado (por ejemplo *"Registro rechazado (401) — revisá extensión/contraseña"*). |
| **No te escuchan** | Revisá el micrófono en Ajustes → Dispositivos y que Windows le haya dado permiso a la app. |
| **No escuchás** | Revisá el altavoz en Ajustes → Dispositivos y el volumen de la llamada. |
| **Conecta pero no hay audio** | Es NAT/medios. Pasale al administrador la etiqueta *VÍA TURN / DIRECTO* y la sección Diagnóstico; puede faltar TURN. |
| **Con certificado interno no conecta (TLS)** | En modo SIP nativo, desactivá *Verificar TLS*; para WebRTC/HTTPS interno la app ya tolera certificados internos. |
| **Se venció el acceso** | Pedile al administrador un enlace nuevo (vencen a las 24 h). |
| **El antivirus marca el `.exe`** | Es porque el instalador puede no estar firmado (ver §13). Es la app; el administrador puede firmarlo para que deje de avisar. |

![Sección de diagnóstico de la app](img/sfd-11-diagnostico.png)

---

## 13. Para el administrador: construir y firmar el instalador

Esta sección es para quien **arma** el instalador (no para el usuario final). El softphone es un
proyecto único: una sola base de código sale como **PWA** (móvil), **web** (navegador) y **app de
Windows** (Electron).

### 13.1 Generar los instaladores

Desde la carpeta `softphone-app/`, en **Windows** (o Linux + wine):

```
npm install
npm run dist          # genera .exe (NSIS) y .msi (WiX) en release/
```

Para una prueba rápida sin empaquetar:

```
npm run build && npm run electron
```

`npm run dist` deja en `release/`:

- **`PBX-NG-Softphone-Setup-x.y.z.exe`** — instalador individual (NSIS), con auto-update.
- **`PBX-NG-Softphone-x.y.z.msi`** — instalador corporativo (WiX), per-machine, para GPO/Intune/SCCM.
- **`win-unpacked/`** — la versión portable.

### 13.2 Si `npm run dist` falla en `winCodeSign`

Si el build corta en `winCodeSign` con *"Cannot create symbolic link … privilegio requerido"*,
es porque electron-builder extrae symlinks y Windows los bloquea sin permiso:

- La app **igual queda armada** en `release/win-unpacked/PBX-NG Softphone.exe` (corre sin instalar).
- Para generar los instaladores: activá el **Modo de desarrollador** de Windows (Configuración →
  Para desarrolladores) **o** corré la terminal **como Administrador**, y reintentá `npm run dist`.
- En **CI** (runner de Windows) no ocurre: usar el workflow de build de Windows.

### 13.3 Auto-update y firma

- El **auto-update** sale por **GitHub Releases** (configurado en `package.json → build.publish`).
  Cada release nueva llega sola a los usuarios.
- **Firma de código**: sin firmar, Windows SmartScreen y algunos antivirus advierten al instalar.
  Para producción conviene firmar el `.exe`/`.msi` con un certificado de firma de código (ver
  `softphone-app/SIGNING.md`).

---

Con esto tenés la app de escritorio de punta a punta: instalada, configurada, en uso, y —del
lado del administrador— construida y distribuida. Para el resto del teléfono (buzón de voz,
colas, códigos útiles) mirá el **Manual de Usuario**.
