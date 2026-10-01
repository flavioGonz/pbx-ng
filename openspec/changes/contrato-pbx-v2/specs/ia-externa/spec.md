## MODIFIED Requirements

### Requirement: Agente de IA conducido por un backend externo

Un agente de IA con el proveedor «IA externa» SHALL atender la llamada con la configuración
de sesión que publica su backend, y SHALL NOT usar el prompt, el saludo, las herramientas ni
la inactividad configurados en el agente.

#### Scenario: Llega una llamada al agente

- **WHEN** entra una llamada a un agente «IA externa» con su configuración bajada
- **THEN** la central SHALL abrir la sesión de voz con esa configuración, sin cambios, y el
  relay de esa llamada
- **AND** el primer mensaje del relay SHALL ser el aviso de la llamada nueva, con quién llama,
  a dónde llamó, el origen (portero o teléfono), la versión de la configuración, el DTMF de
  apertura, el destino de los agentes y `reanudar: false`

#### Scenario: El backend no engancha la llamada a tiempo

- **WHEN** el backend no confirma la llamada por el relay dentro del tiempo que publica en su
  configuración, o la rechaza
- **THEN** la central SHALL cerrar la sesión y aplicar el respaldo

### Requirement: Configuración de la sesión publicada por el backend

La central SHALL bajar la configuración de la sesión del backend, guardarla para sobrevivir
a un reinicio y volver a bajarla solo cuando el backend avisa que cambió. La configuración
incluye `resumeWindowMs`: cuánto intenta reabrir el relay de una llamada en curso.

#### Scenario: El backend avisa que cambió la configuración

- **WHEN** el backend manda la orden de refrescar la configuración por el canal de control
- **THEN** la central SHALL pedirla mandando la versión que tiene, y si cambió SHALL
  guardar la nueva
- **AND** SHALL confirmar la orden recién después de guardarla, o informarla como fallida si
  no pudo

#### Scenario: Configuración que no es de GPT-Live

- **WHEN** la configuración publicada pide un modelo que no es GPT-Live
- **THEN** la central SHALL rechazarla y conservar la anterior

#### Scenario: Reinicio de la API de la central

- **WHEN** la API de la central se reinicia
- **THEN** el agente SHALL seguir atendiendo con la última configuración guardada, sin
  esperar a que el backend se reconecte

#### Scenario: Ventana de reanudación acotada

- **WHEN** la configuración publicada trae un `resumeWindowMs` fuera de rango o no lo trae
- **THEN** la central SHALL acotarlo a un rango razonable (por ejemplo, de 0 a 60 s) o usar
  su valor por defecto

### Requirement: Relay de la sesión al backend

Durante la llamada, la central SHALL reenviarle al backend, por el relay de esa llamada, cada
evento de la sesión de voz, y SHALL dejar pasar hacia la sesión solo las frases y el cierre
que mande el backend. Cada evento de la sesión y cada hecho que la central le manda al
backend SHALL llevar un número de orden (`seq`) que crece de a uno en toda la llamada, y la
central SHALL guardar los últimos para reenviarlos. El aviso de la llamada y las respuestas
a las órdenes (`ack`, `orden_fallida`) no se numeran: si una respuesta se pierde, el
backend reenvía la orden y la central repite la respuesta.

#### Scenario: Eventos de la sesión

- **WHEN** la sesión de voz produce un evento, o la central le manda audio de quien llama
- **THEN** el backend SHALL recibirlo tal cual por el relay de esa llamada, con su `seq`

#### Scenario: El backend manda un mensaje no permitido

- **WHEN** el backend manda por el relay un mensaje que no es agregar instrucciones,
  agregar un comentario, cerrar la sesión, confirmar o rechazar el enganche, o una orden
- **THEN** la central SHALL descartarlo sin pasarlo a la sesión

### Requirement: Órdenes del backend sobre la llamada

La central SHALL ejecutar las órdenes del backend (colgar, transferir, mandar DTMF) que
llegan por el relay de una llamada, solo sobre esa llamada, y SHALL confirmar cada orden por
el mismo relay después de ejecutarla, una sola vez mientras dure la llamada, aunque el relay
se haya reabierto.

#### Scenario: Orden ejecutada

- **WHEN** el backend manda una orden válida por el relay de una llamada
- **THEN** la central SHALL ejecutarla y recién después contestar la confirmación con el id
  de la orden
- **AND** si no la pudo ejecutar SHALL informarla como fallida, con el motivo

#### Scenario: Orden repetida

- **WHEN** el backend reenvía una orden con un id que la central ya procesó en esa llamada,
  por el mismo relay o por uno reabierto
- **THEN** la central SHALL NOT ejecutarla otra vez y SHALL repetir la respuesta que dio

#### Scenario: Transferencia a un destino no permitido

- **WHEN** el backend ordena transferir a un destino que no es el de agentes ni el de
  respaldo del agente
- **THEN** la central SHALL rechazar la orden sin transferir, porque desde ese contexto
  también se alcanzan las troncales y la DISA

#### Scenario: Orden sobre una llamada ajena

- **WHEN** llega por el relay de una llamada una orden con el id de otra llamada
- **THEN** la central SHALL rechazarla

#### Scenario: Colgar o transferir durante la despedida

- **WHEN** llega colgar o transferir mientras todavía suena audio del asistente
- **THEN** la central SHALL esperar a que termine ese audio, hasta 5 s, antes de ejecutar

#### Scenario: Apertura del portón

- **WHEN** el backend ordena mandar el DTMF de apertura
- **THEN** la central SHALL mandarlo en la llamada y dejarlo registrado en la auditoría de
  acciones de la IA

#### Scenario: Orden con la llamada ya terminada

- **WHEN** llega una orden nueva cuando la llamada ya terminó o ya se mandó al respaldo
- **THEN** la central SHALL NOT ejecutarla y SHALL contestarla como fallida ("la llamada ya
  no está en curso"); una orden ya hecha repite su respuesta

#### Scenario: La orden que termina la llamada

- **WHEN** el backend manda colgar y la central termina la llamada
- **THEN** la central SHALL mandar la confirmación de la orden antes de cerrar el relay, con
  un tope (un parámetro) para una orden trabada

### Requirement: Hechos de la llamada para el backend

La central SHALL avisarle al backend todo lo que pasa en la llamada que el backend no
ordenó: por el relay mientras está abierto, y por HTTP
(`POST /api/pbx/llamadas/:pbxCallId/hechos`, con el token) cuando el relay ya se cerró.

#### Scenario: Termina la llamada sin orden del backend

- **WHEN** la llamada termina porque colgó quien llama, se cortó el audio, se llegó a un
  tope o se apagó el servicio
- **THEN** el backend SHALL recibir el aviso de que colgó

#### Scenario: Quien llama marca dígitos o termina una transferencia

- **WHEN** quien llama marca un DTMF, o una transferencia ordenada termina bien o mal
- **THEN** el backend SHALL recibir el hecho correspondiente, con el resultado

#### Scenario: La transferencia termina con el relay cerrado

- **WHEN** la transferencia al agente falla después de que se cerró el relay
- **THEN** la central SHALL mandar el hecho por HTTP, y reintentarlo unas pocas veces si el
  backend no contesta

### Requirement: Canal de control con reconexión

La central SHALL mantener un canal de control por backend, compartido por todos sus agentes,
y SHALL detectar su caída y reconectarse sola. El canal SHALL llevar solo el latido y la
orden de refrescar la configuración: ninguna llamada, orden de llamada ni hecho.

#### Scenario: El backend deja de responder

- **WHEN** pasan 15 s sin el latido del backend
- **THEN** la central SHALL dar el canal por caído y reconectarse con esperas crecientes,
  de 1 a 10 s

#### Scenario: Token rechazado

- **WHEN** el backend rechaza el token
- **THEN** la central SHALL reintentar cada 60 s y avisarlo una sola vez en el log

#### Scenario: El canal se cae con llamadas en curso

- **WHEN** el canal de control se cae mientras hay llamadas en curso
- **THEN** las llamadas SHALL seguir por sus relays, sin cambios

### Requirement: Respaldo sin backend

Una llamada a un agente «IA externa» SHALL NOT quedar muda ni colgada sin destino por un
problema del backend: SHALL ir al destino de respaldo del agente, o colgarse si no tiene.

#### Scenario: No hay backend o no hay configuración

- **WHEN** entra una llamada y nunca se bajó la configuración, o no se puede abrir el relay
- **THEN** la central SHALL transferirla al respaldo, sin abrir la sesión de voz si no hay
  configuración

#### Scenario: Se cierra la sesión sin orden

- **WHEN** se cierra la sesión y pasan 5 s sin que llegue colgar ni transferir
- **THEN** la central SHALL aplicar el respaldo

#### Scenario: El relay no se puede reabrir

- **WHEN** el relay de una llamada en curso se corta y la central no lo puede reabrir dentro
  de `resumeWindowMs`
- **THEN** la central SHALL cerrar la sesión y aplicar el respaldo

#### Scenario: OpenAI corta la sesión

- **WHEN** la sesión de voz se corta sin aviso del lado de OpenAI
- **THEN** la central SHALL avisarle al backend por el relay con un `session.closed` propio,
  numerado como los demás eventos, y SHALL dejar el relay abierto para la orden final (un
  cierre del relay significa «reabrir»)

## ADDED Requirements

### Requirement: Reanudar el relay de una llamada en curso

Si el relay de una llamada en curso se corta sin que la llamada haya terminado, la central
SHALL reabrirlo (el primer intento enseguida, después cada 1 s) durante `resumeWindowMs`,
mientras la sesión de voz sigue. Al reabrir SHALL avisar la llamada con `reanudar: true` y
el último `seq` que mandó, y SHALL reenviar los mensajes guardados desde el `seq` que le pida
el backend al confirmar.

#### Scenario: Se cae la instancia del backend

- **WHEN** se corta el relay de una llamada en la que quien llama está hablando con el
  asistente
- **THEN** la central SHALL reabrir el relay y avisar la llamada con `reanudar: true`
- **AND** al recibir la confirmación con `desde`, SHALL reenviar los mensajes desde ese `seq`,
  en orden, y seguir normal
- **AND** la sesión de voz SHALL NOT cortarse durante la reapertura

#### Scenario: El backend pide desde un seq que ya no está guardado

- **WHEN** el backend pide reenviar desde un `seq` más viejo que el primero guardado
- **THEN** la central SHALL reenviar desde el primero que tiene, y el backend se entera del
  hueco por el `seq`

#### Scenario: Una instancia del backend congelada

- **WHEN** la instancia que tiene el relay deja de contestar sin cerrar la conexión (el
  proceso trabado, o la red cortada sin aviso)
- **THEN** la central SHALL notarlo por el latido del relay (un ping cada pocos segundos, sin
  respuesta en un tiempo límite que es un parámetro) y SHALL reabrirlo como en cualquier corte

#### Scenario: La llamada termina mientras el relay se reabre

- **WHEN** quien llama corta mientras el relay se está abriendo o reabriendo
- **THEN** la central SHALL NOT mandar el aviso ni volver a reabrirlo

### Requirement: Reubicar ante el apagado ordenado del backend

Si el backend cierra el relay con el código 4001 ("reubicar"), la central SHALL reabrirlo al
instante, sin esperar, como en una reanudación. Solo el primer intento de cada corte sale sin
esperar: si los siguientes también reciben 4001, la central SHALL espaciarlos como en
cualquier reanudación, sin un bucle de reaperturas.

#### Scenario: Despliegue del backend con una llamada en curso

- **WHEN** el backend se apaga en orden y cierra el relay con 4001
- **THEN** la central SHALL reabrir el relay enseguida con otra instancia, y la llamada SHALL
  seguir sin ir al respaldo
