# Design

## Context

Ver proposal.md, sección Why. Lo que ya existía y condicionó el enfoque:

- **El puente de audio a GPT-Live** (`realtime.js`): WebSocket a OpenAI, remuestreo de 8 a
  24 kHz, ritmo de 20 ms y descarte del audio pendiente cuando quien llama interrumpe. Está
  probado en llamadas reales y no hay motivo para duplicarlo en otro sistema.
- **El agente de IA propio** (`ai-pipeline.js`) arma la sesión con su prompt, sus
  herramientas y su escalera de inactividad, y transfiere con `continueInDialplan` hacia el
  contexto `internal`.
- **La llamada que sale de la IA ya está atendida**: el `ivr` hace `Answer()` antes de
  pasarla al agente.
- **La imagen de Asterisk no traía `indications.conf`** (`indication show` vacío).

## Goals / Non-Goals

**Goals:**
- Que la lógica de la conversación de la portería viva en un solo lugar, el backend del
  asistente, y que cambiarla nunca obligue a desplegar la central. El contrato se considera
  estable: solo se toca ante un cambio que lo rompa.
- Que la central no confíe en el backend más de lo necesario: el backend no puede transferir
  a cualquier lado ni mandar sobre llamadas ajenas.
- Que ninguna falla del backend deje a quien llama en silencio.

**Non-Goals:**
- Cambiar el agente de IA propio de la central: sigue igual para quien no use el proveedor
  nuevo.
- Generalizar el relay a otros modelos que no sean GPT-Live.
- Cambiar cómo suena una llamada directa entre internos.

## Decisions

**1. La central sigue abriendo la sesión de voz y le hace de relay al backend.**
- El backend necesita ver la sesión entera (transcripciones, inicio y fin del habla, fin de
  las respuestas) para conducirla. Lo natural sería el sideband de OpenAI, pero **a una
  sesión abierta por WebSocket no se puede enganchar: da 404**. Por eso cada evento le llega
  al backend por un WebSocket por llamada.
- **Descartado: que el backend abra la sesión con OpenAI** y la central le pase el audio
  crudo. Habría que mover al backend el remuestreo, el ritmo y el barge-in, que ya funcionan
  en la central, y sumar un salto de audio en el camino crítico de la latencia.
- Hacia la sesión, el relay deja pasar **solo** agregar instrucciones, agregar un comentario
  y cerrar. El backend no necesita más para conducir, y así no puede cambiar el modelo, la
  voz ni las herramientas en mitad de la llamada.

**2. La configuración de la sesión la publica el backend, con versión.**
- La central la baja con `If-None-Match` y la guarda en la base
  (`pbxng_ia_externa_config`): un reinicio de la API no deja al agente sin configuración ni
  depende de que el backend esté arriba en ese momento.
- La baja cuando el backend manda `refrescar_config`, al conectarse el canal o cuando cambia
  la configuración. **Descartado: bajarla en cada llamada**, porque suma latencia al
  atender y hace depender cada llamada de una consulta HTTP.
- Se rechaza una configuración cuyo modelo no es GPT-Live, porque el relay está hecho para
  los eventos de esa API.

**3. Las órdenes van por un canal de control, separado del relay.**
- Hay un canal por backend, que comparten sus agentes, y no uno por llamada: las órdenes de
  configuración no pertenecen a ninguna llamada, y así hay un solo latido que vigilar.
- **Ack después de ejecutar** y no al recibir: el backend sabe que el portón se abrió o que
  la transferencia salió, no solo que la orden llegó.
- **Las repetidas no se ejecutan dos veces:** el backend reenvía si no vio el ack, y un
  DTMF de apertura repetido abriría el portón dos veces.
- **Los destinos de transferencia se limitan** a los de agentes y de respaldo del agente,
  porque desde `internal` también se alcanzan las troncales y la DISA. **Descartado: dejar
  que el backend elija cualquier interno.** Un backend comprometido podría sacar llamadas
  pagas.
- Colgar y transferir esperan a que suene lo que queda en la cola de audio, hasta 5 s, para
  no cortar la despedida o el anuncio de la derivación.

**4. El respaldo es el destino «Por defecto» del agente.**
- Se reusa el campo que ya existía. Sin backend o sin configuración, la llamada se
  transfiere sin abrir sesión.
- Si se cierra la sesión sin orden, se espera 5 s antes del respaldo: el backend primero
  cierra la sesión (se despide o anuncia la derivación) y recién después manda colgar o
  transferir.

**5. URL http o https, a elección de la instalación.** El usuario lo decidió el 30/09: por la
URL viajan el token, el audio y las órdenes que abren el portón, así que se recomienda
https, pero la central no lo impone, porque hay instalaciones en una red propia y backends
detrás de un proxy.

**6. El silencio de la derivación se arregla con las zonas de tono, no con el 180.**
- Sobre un canal ya atendido Asterisk no manda 180: el tono lo tiene que generar el core por
  audio, con la zona de tono. Sin `indications.conf` no había zona, así que ni el aviso de
  ringing del interno ni la opción `r` producían audio.
- La imagen trae `indications.conf` con `uy` y `ar`, con los valores de la UIT (Anexo al
  Boletín de Explotación 781), y el país sale de `TONE_COUNTRY`, que aplica el entrypoint.

**7. La opción `r` solo en las derivaciones, por una variable de canal.**
- La central pone `DIAL_OPCIONES=r` antes de transferir, y la leen los `Dial` del interno,
  del sígueme, de los grupos de timbre y de las opciones de IVR. En una llamada directa la
  variable está vacía y el `Dial` queda igual.
- La variable va sin `_`, así que no se hereda a los canales que se marcan.
- **Descartado: `r` siempre**, porque en una llamada directa reemplazaría el audio temprano
  real del destino por un tono genérico.
- Con la variable puesta, el despertar de un interno dormido arranca con `Ringing()`. El
  tono empieza recién cuando vuelve el `CURL` del despertar, que bloquea el canal sin
  leerlo, hasta unos 6 s.

**8. Migración solo de la forma exacta que escribía el panel.** La 0030 agrega
`,${DIAL_OPCIONES}` a los `Dial` de grupos e IVR que tienen la forma exacta generada por
`apps.js`. Las filas editadas a mano no se tocan, y la migración es idempotente.

**9. El puente de la IA es softmix (`mixing,video_sfu`), agregado el 30/09.**
- **Por qué:** con `mixing`, para dos canales Asterisk elige el puente simple, que iguala las
  negociaciones de las dos puntas (`bridge_simple.c`). El canal de AudioSocket no tiene
  video, así que el portero perdía el suyo (re-INVITE con `m=video 0`) y el `Dial` al agente
  salía sin video. Se vio con el registro SIP en la central local.
- `video_sfu` es la única opción de ARI que fuerza el softmix y le saca lo "inteligente" al
  puente (`res_stasis.c`). El softmix no le cambia la negociación a nadie. No suma latencia
  medible: en las dos llamadas de prueba, del fin del habla a la voz del asistente fue ~2,1 s
  con softmix y ~2,2 s con el simple.
- **Descartado: volver a ofrecer el video desde el teléfono después de la derivación.** Lo
  tendría que hacer cada portero, y un portero de hardware no lo hace.

## Risks / Trade-offs

- **[Las zonas de tono valen para toda llamada atendida]** → `Busy()`, `Congestion()` y las
  transferencias ciegas hechas por personas pasan a sonar. Se acepta: era silencio, y ahora
  suena lo que corresponde.
- **[Con `r`, en el sígueme se pierde el audio temprano del celular]**, como el «apagado o
  fuera del área» → se acepta en la derivación, donde el tono importa más.
- **[La grabación de la transferencia incluye el tono]** → se acepta.
- **[Un backend lento demora el atender]** → la espera del enganche está acotada entre 1 y
  30 s, y después va el respaldo.
- **[Un backend comprometido]** → solo puede transferir a dos destinos, solo sobre sus
  llamadas, y cada apertura queda auditada en `pbxng_ia_acciones`.
- **[Un grupo de timbre muy largo no entra en la columna]** → queda sin tono, y la migración
  lo nombra en el log.

## Migration Plan

1. Las migraciones 0029 y 0030 las aplica `migrate.js` desde el entrypoint de la API, antes
   de que arranque.
2. **Reconstruir la imagen de Asterisk** (trae `indications.conf` y el `extensions.conf`
   nuevo) y la de la API.
3. Opcional: `TONE_COUNTRY` en `docker/.env` si la central no es de Uruguay.
4. Crear el agente «IA externa» en el panel, con la URL y el token del backend.

**Rollback:** deshabilitar el agente o volver su proveedor a uno propio. Las tablas y la
variable de canal quedan sin uso, y con la variable vacía los `Dial` se comportan como
antes.
