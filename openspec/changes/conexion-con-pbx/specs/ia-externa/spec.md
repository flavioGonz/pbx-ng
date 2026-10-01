## Purpose

Cómo un backend externo, el del asistente de voz de la portería, conduce una llamada que
atiende la central: la central pone el audio y ejecuta órdenes, y el backend decide qué decir
y qué hacer con la llamada. El contrato detallado de mensajes está en `docs/CONTRATOS.md` §11.

## ADDED Requirements

### Requirement: Agente de IA conducido por un backend externo

Un agente de IA con el proveedor «IA externa» SHALL atender la llamada con la configuración
de sesión que publica su backend, y SHALL NOT usar el prompt, el saludo, las herramientas ni
la inactividad configurados en el agente.

#### Scenario: Llega una llamada al agente

- **WHEN** entra una llamada a un agente «IA externa» con su backend conectado y su
  configuración bajada
- **THEN** la central SHALL abrir la sesión de voz con esa configuración, sin cambios
- **AND** SHALL avisarle al backend la llamada nueva, con quién llama, a dónde llamó, el
  origen (portero o teléfono), la versión de la configuración, el DTMF de apertura y el
  destino de los agentes

#### Scenario: El backend no engancha la llamada a tiempo

- **WHEN** el backend no confirma la llamada dentro del tiempo que publica en su
  configuración, o la rechaza
- **THEN** la central SHALL cerrar la sesión y aplicar el respaldo

### Requirement: Validación de la configuración del agente

Al guardar un agente «IA externa», la central SHALL rechazar con 400 una configuración que
no le permita atender o que la exponga a órdenes peligrosas.

#### Scenario: Datos obligatorios o inválidos

- **WHEN** se guarda un agente sin URL del backend, con una URL que no es http(s) válida, sin
  token o sin ningún destino (ni de agentes ni de respaldo)
- **THEN** la central SHALL rechazarlo con 400 y no guardarlo

#### Scenario: DTMF de apertura inválido

- **WHEN** el DTMF de apertura tiene caracteres fuera de `0-9 * # A-D`
- **THEN** la central SHALL rechazarlo con 400

#### Scenario: URL por http

- **WHEN** la URL del backend es http, en la red de la central o por internet
- **THEN** la central SHALL aceptarla; la elección entre http y https queda a cargo de la
  instalación

### Requirement: Configuración de la sesión publicada por el backend

La central SHALL bajar la configuración de la sesión del backend, guardarla para sobrevivir
a un reinicio y volver a bajarla solo cuando el backend avisa que cambió.

#### Scenario: El backend avisa que cambió la configuración

- **WHEN** el backend manda la orden de refrescar la configuración
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

### Requirement: Relay de la sesión al backend

Durante la llamada, la central SHALL reenviarle al backend cada evento de la sesión de voz y
SHALL dejar pasar hacia la sesión solo las frases y el cierre que mande el backend.

#### Scenario: Eventos de la sesión

- **WHEN** la sesión de voz produce un evento, o la central le manda audio de quien llama
- **THEN** el backend SHALL recibirlo tal cual por el relay de esa llamada

#### Scenario: El backend manda un mensaje no permitido

- **WHEN** el backend manda por el relay un mensaje que no es agregar instrucciones,
  agregar un comentario ni cerrar la sesión
- **THEN** la central SHALL descartarlo sin pasarlo a la sesión

### Requirement: Órdenes del backend sobre la llamada

La central SHALL ejecutar las órdenes del backend (colgar, transferir, mandar DTMF) solo
sobre las llamadas de sus propios agentes, y SHALL confirmar cada orden después de
ejecutarla, una sola vez.

#### Scenario: Orden ejecutada

- **WHEN** el backend manda una orden válida sobre una llamada suya
- **THEN** la central SHALL ejecutarla y recién después contestar la confirmación con el id
  de la orden
- **AND** si no la pudo ejecutar SHALL informarla como fallida, con el motivo

#### Scenario: Orden repetida

- **WHEN** el backend reenvía una orden con un id que la central ya procesó
- **THEN** la central SHALL NOT ejecutarla otra vez y SHALL repetir la respuesta que dio

#### Scenario: Transferencia a un destino no permitido

- **WHEN** el backend ordena transferir a un destino que no es el de agentes ni el de
  respaldo del agente
- **THEN** la central SHALL rechazar la orden sin transferir, porque desde ese contexto
  también se alcanzan las troncales y la DISA

#### Scenario: Orden sobre una llamada ajena

- **WHEN** un backend manda una orden sobre una llamada de un agente que no es suyo
- **THEN** la central SHALL rechazarla

#### Scenario: Colgar o transferir durante la despedida

- **WHEN** llega colgar o transferir mientras todavía suena audio del asistente
- **THEN** la central SHALL esperar a que termine ese audio, hasta 5 s, antes de ejecutar

#### Scenario: Apertura del portón

- **WHEN** el backend ordena mandar el DTMF de apertura
- **THEN** la central SHALL mandarlo en la llamada y dejarlo registrado en la auditoría de
  acciones de la IA

### Requirement: Hechos de la llamada para el backend

La central SHALL avisarle al backend todo lo que pasa en la llamada que el backend no
ordenó.

#### Scenario: Termina la llamada sin orden del backend

- **WHEN** la llamada termina porque colgó quien llama, se cortó el audio, se llegó a un
  tope o se apagó el servicio
- **THEN** el backend SHALL recibir el aviso de que colgó

#### Scenario: Quien llama marca dígitos o termina una transferencia

- **WHEN** quien llama marca un DTMF, o una transferencia ordenada termina bien o mal
- **THEN** el backend SHALL recibir el hecho correspondiente, con el resultado

### Requirement: Canal de control con reconexión

La central SHALL mantener un canal de control por backend, compartido por todos sus
agentes, y SHALL detectar su caída y reconectarse sola.

#### Scenario: El backend deja de responder

- **WHEN** pasan 15 s sin el latido del backend
- **THEN** la central SHALL dar el canal por caído y reconectarse con esperas crecientes,
  de 1 a 10 s

#### Scenario: Token rechazado

- **WHEN** el backend rechaza el token
- **THEN** la central SHALL reintentar cada 60 s y avisarlo una sola vez en el log

### Requirement: Respaldo sin backend

Una llamada a un agente «IA externa» SHALL NOT quedar muda ni colgada sin destino por un
problema del backend: SHALL ir al destino de respaldo del agente, o colgarse si no tiene.

#### Scenario: No hay backend o no hay configuración

- **WHEN** entra una llamada y el canal de control está caído o nunca se bajó la
  configuración
- **THEN** la central SHALL transferirla al respaldo sin abrir la sesión de voz

#### Scenario: Se cierra la sesión sin orden

- **WHEN** se cierra la sesión o el relay y pasan 5 s sin que llegue colgar ni transferir
- **THEN** la central SHALL aplicar el respaldo

#### Scenario: OpenAI corta la sesión

- **WHEN** la sesión de voz se corta sin aviso del lado de OpenAI
- **THEN** la central SHALL cerrar el relay para que el backend se entere
