# Design

## Lo que hay hoy

Tres piezas, y las tres hay que tocarlas.

**1. La regla de las cámaras** (`App.jsx`):

```js
const camsEnLlamada = (!entrante && !finCall) ? camaras : [];
```

El `!entrante` apaga las cámaras del cliente mientras timbra. Es la causa directa de lo que
se ve.

**2. Los controles viven en el bloque que se oculta** (`CallScreen.jsx`). Cuando hay escena
de video, el bloque central se oculta entero:

```js
<div className={'cs-centro ' + gesto} style={video ? { display: 'none' } : undefined}>
```

y adentro de ese bloque están los redondos de atender / atender con video / rechazar, el
nombre de quien llama y la ficha del CRM. Encender las cámaras al timbrar sin mover nada más
deja una llamada que se ve y no se puede atender. **Este es el punto que convierte el cambio
de una línea en un cambio de verdad.**

**3. No existe cámara propia antes de atender.** `localStreamRef` se llena cuando la sesión
SIP arma sus medios (`useSip.js`); antes de aceptar, `getLocalStream()` devuelve `null`. La
miniatura propia durante el timbrado no es «mostrar algo que ya está»: hay que pedir la
cámara aparte.

## Decisiones

### La previa de cámara se abre una vez y se le entrega a la sesión

Cuando entra una llamada se pide la cámara con `getUserMedia`, se muestra en la miniatura, y
**esa misma pista** se le pasa a la sesión al aceptar con video.

La alternativa —abrir la previa, cerrarla al aceptar y dejar que la sesión pida la cámara de
nuevo— es la que parece más simple y es la que falla: en Windows, soltar y volver a tomar la
cámara en el mismo segundo da «dispositivo en uso» con varios drivers, y el resultado sería
peor que ahora, porque hoy la cámara funciona al atender. Si entregar la pista resulta
inviable en el motor nativo, se prefiere NO mostrar la previa en ese motor antes que romper
el video de la llamada.

La previa se libera al rechazar, al vencer el timbrado y al aceptar sin video.

### «Sólo si la llamada no trae video» se decide con lo que anuncia el INVITE

`sp.incomingVideo` ya dice si la llamada entrante ofrece video. Si ofrece, no se encienden
las cámaras del cliente durante el timbrado.

Esto introduce una asimetría a propósito, y conviene tenerla escrita: en una SALIENTE no se
sabe de antemano si el otro lado va a mandar imagen, así que las cámaras se encienden
mientras timbra. En una ENTRANTE sí se sabe, y se respeta. No es una inconsistencia del
diseño sino una diferencia de información disponible. Si en la práctica molesta —un portero
que anuncia video y nunca manda imagen deja la pantalla vacía hasta atender— la salida es
encender las cámaras igual y dejar que la regla de siempre decida cuál va al principal.

### La fuente principal sigue decidiéndola la regla que ya existe

Manda el video de la llamada mientras exista; si no hay, la primera cámara del cliente; y la
elección manual del usuario gana hasta que corte. No se toca: es la que hace que atender no
corte lo que se estaba mirando.

## Riesgos

- **La cámara se enciende en llamadas que no se aceptaron.** Es lo pedido, pero significa que
  la luz del equipo se prende ante cualquier llamada entrante. Si molesta, el interruptor
  natural es una preferencia junto a «Auto-atender».
- **Ancho de banda del cliente.** Cada timbrado de un cliente con cámaras hace que go2rtc
  tire del RTSP. Con un portero que insiste tres veces son tres arranques de stream.
- **Dos motores.** `useSip.js` (WebRTC) y `useSipNative.js` (SIP nativo) manejan los medios
  distinto. La previa hay que resolverla en los dos, y el nativo es el que tiene más chances
  de no poder entregar la pista.
