# Agente IA en cola — portería remota atendida por IA

> Estado: **idea ordenada + cuatro decisiones tomadas** (2026-09-23). Sigue sin código.
> Lo que está medido dice «medido»; lo demás es diseño o estimación y lo dice también.

---

## 0. Decisiones tomadas (2026-09-23)

| # | Decisión | Estado |
|---|---|---|
| Proveedor | **Modelo realtime de OpenAI** (familia *GPT realtime*), audio in / audio out por un único WebSocket | **Decidido** |
| Módulo | Es **PBX-NG**, un **módulo activable** más (como Portería), apagado de fábrica | **Decidido** |
| Voz y registro | El *prompt* se escribe **a partir de tres llamadas reales** del centro de monitoreo, no al revés | **Decidido** |
| Quién revisa | **Los operarios que ya están.** Ver §3.4: no es gente nueva, es la misma pantalla del centro con otro trabajo | **Decidido** |
| Alcance del piloto | qué cliente, qué portero, qué horario | **Pendiente** |

**Sobre el modelo, una advertencia operativa:** el identificador exacto del modelo realtime
cambia seguido, así que va como **ajuste por agente** (`pbxng_ai_agents.model`), nunca
escrito en el código. El día que el proveedor retire el que estamos usando, tiene que ser
un cambio en el panel y no un release. Lo mismo con el proveedor: el pipeline queda detrás
de una interfaz (`provider`) para poder comparar el camino de hoy —STT → LLM → TTS— contra
el realtime con el mismo agente y el mismo *prompt*, que es la única forma honesta de
medir cuál conviene.

---

## 1. La idea, en una frase

**Que el centro de monitoreo deje de tener agentes humanos atendiendo porteros: que atienda
un agente de IA que habla con el visitante por la llamada, verifica lo que dice contra los
datos del cliente, deja evidencia (transcripción + captura de la cámara) y sólo escala a
una persona cuando hace falta.**

El humano no desaparece: **cambia de lugar**. Deja de atender cada timbre y pasa a revisar
lo que el agente registró y a resolver las excepciones. Ese cambio —de *atender* a
*supervisar*— es el que justifica el proyecto, y también el que define el riesgo: lo que
hoy hace una persona con criterio, mañana lo hace un modelo con reglas.

---

## 2. Qué existe ya (y es mucho más de lo que parece)

Esto no arranca de cero. Medido contra el repo, hoy:

| Pieza | Dónde | Qué hace hoy |
|---|---|---|
| Pipeline de voz conversacional | `control-plane/ai-pipeline.js` | STT → LLM → TTS sobre **AudioSocket** (TCP :9092) vía `ARI externalMedia`, con **barge-in** (corta el TTS cuando el visitante habla), VAD por energía y pacing de 20 ms |
| Agentes de IA | tabla `pbxng_ai_agents`, pantalla `/voz` | nombre, interno, saludo, *system prompt*, voz, proveedor, modelo, y tres destinos de transferencia (ventas / soporte / default) |
| Entrada por dialplan | `Stasis(pbxng,ai,<id>)` | un IVR con IA ya se puede marcar |
| Herramienta de CRM | `crmLookup()` | el modelo ya puede consultar datos por webhook (con tope de 2,5 s desde la Tanda 0) |
| Colas | `apps.js`, tabla `queues` + `pbxng_queues` | estrategias, timbrado, reintento, capacidad, grabación automática |
| Portería / CRM propio | `pbxng_clients`, `pbxng_client_devices`, `/intercom` | clientes, personas, espacios, dispositivos (portero) con su URL RTSP, y **go2rtc** para el video |
| Grabación | `recordings.js` | MixMonitor + índice + transcripción y análisis de texto |
| Contrato con el backoffice | `/api/v1` + outbox (Tanda 1, en curso) | credencial de sistema, identidad de llamada y eventos salientes |

**Conclusión: lo que falta no es la IA. Falta el pegamento** — que el agente sea miembro de
una cola, que tenga herramientas con permisos, y que deje evidencia revisable.

---

## 3. Las cuatro decisiones que hay que tomar antes de escribir una línea

### 3.1 ¿Pipeline en tres pasos o modelo *realtime*?

Hoy: **STT → LLM → TTS**, tres llamadas de red por turno. Anda, y tiene barge-in, pero la
latencia se suma: transcribir + pensar + sintetizar. En una conversación de portería —donde
el visitante dice tres palabras y espera— eso se nota.

Un **modelo realtime** (audio entra, audio sale, por un único WebSocket) reemplaza los tres
por uno y baja la latencia a un ida y vuelta. Lo que cambia en el código no es poco:

- `ai-pipeline.js` deja de hacer VAD y pacing propios y pasa a ser un **puente**: AudioSocket
  (slin 8 kHz, frames de 20 ms) ↔ WebSocket del modelo (normalmente PCM16 a 24 kHz). Hay que
  **remuestrear en los dos sentidos** y sostener el ritmo: un modelo que manda audio a
  ráfagas contra un canal que consume 20 ms cada 20 ms necesita colchón, y el colchón es
  latencia. El pacing con corrección de deriva que ya existe sirve de base.
- El barge-in lo maneja el modelo (detección de voz del lado de ellos), pero **el corte del
  audio en curso lo seguimos haciendo nosotros**, porque el que tiene el socket con Asterisk
  es este proceso.
- Las **herramientas** (function calling) pasan a ser del modelo realtime, con su propio
  formato.

**Recomendación:** empezar con el pipeline actual —ya funciona y es el que conocemos— y
**poner el modelo realtime detrás de la misma interfaz**, como un proveedor más
(`pbxng_ai_agents.provider`). Así se puede comparar los dos con el mismo agente y el mismo
prompt, que es la única forma honesta de decidir. Lo que **no** hay que hacer es reescribir
el pipeline y cambiar de arquitectura de voz al mismo tiempo: si sale mal, no se sabe cuál
de las dos cosas falló.

### 3.2 ¿Cómo entra el agente a la cola?

El agente tiene que ser **miembro de la cola**, no un destino al que la cola rebota. Tres
caminos, en orden de preferencia:

1. **Miembro `Local/<exten-ia>@ia-agentes`** agregado con `QueueAdd` por AMI. La cola lo
   trata como a cualquier agente: estrategia, timbrado, capacidad, pausa. El canal Local
   cae en el dialplan, que hace `Stasis(pbxng,ai,<id>)`, y de ahí al pipeline.
   **La concurrencia se controla con la cantidad de miembros**: un agente IA que puede
   atender tres llamadas a la vez son tres miembros. Esto es importante y no es obvio: sin
   límite, una ráfaga de timbres abre veinte sesiones de modelo a la vez, y eso se paga en
   dólares por minuto.
2. Miembro estático en `pbxng_queues`, marcado como `tipo='ia'`. Más simple, menos flexible
   (no se puede pausar ni escalar solo).
3. Destino de desborde («si no contesta nadie en 20 s, va a la IA»). Es el **modo de
   transición** y probablemente el primero que se despliegue en producción: el humano sigue
   primero y la IA atiende lo que se caería.

**La pausa del agente IA importa**: si el proveedor del modelo no responde, el agente tiene
que **pausarse solo en la cola** para que las llamadas vayan a los humanos, en vez de
atender y quedarse mudo. Un agente que atiende y no habla es peor que uno que no atiende.

### 3.3 ¿Qué puede HACER el agente? (el catálogo de herramientas)

Acá está el valor y acá está el riesgo. Cada herramienta es una función declarada con su
esquema, su permiso y su registro:

| Herramienta | Qué hace | Riesgo | Regla |
|---|---|---|---|
| `buscar_cliente(numero\|nombre\|unidad)` | ficha del CRM propio (`pbxng_clients`, personas, espacios) | bajo | sólo lectura |
| `verificar_visita(nombre, documento, unidad)` | contrasta contra visitas esperadas / lista del cliente | bajo | sólo lectura |
| `tomar_captura(dispositivo)` | snapshot del portero por go2rtc, guardada con la visita | bajo | siempre que suene el portero, sin preguntar |
| `registrar_visita(datos)` | crea el registro con lo que el visitante declaró | medio | **lo declarado se guarda como declarado**, nunca como verificado |
| `llamar_al_residente(unidad)` | llama al interno/celular del vecino y le pregunta | medio | es el camino por defecto ante la duda |
| `transferir_a_humano(motivo)` | escala al operador del centro | bajo | siempre disponible, y el motivo queda escrito |
| `abrir_porton(dispositivo, motivo)` | **abre la puerta** | **ALTO** | ver abajo |

**La regla de la puerta, escrita antes de programarla:** el agente **no abre por lo que el
visitante dice**. Abre sólo cuando (a) hay una **visita esperada** cargada por el residente
que coincide, o (b) el **residente autorizó en vivo** en la llamada que el agente le hizo, o
(c) el visitante está en una **lista blanca** del cliente. Cualquier otro caso es
`transferir_a_humano`. Y el fail-safe es al revés que en la DISA: **si algo falla —el CRM no
contesta, el modelo se cae, hay dudas— NO se abre**. Eso hay que escribirlo en
`docs/CONTRATOS.md` al lado de la excepción del screen-pop, o el próximo que toque esto lo
va a romper sin saberlo.

### 3.4 ¿Qué evidencia queda, y quién la revisa?

Es la mitad de la idea del dueño («luego verificaremos los datos suministrados, tomaremos
capturas») y es lo que hace el proyecto defendible ante un cliente:

Cada atención del agente produce **un registro de visita** con:

- `call_id` / `leg_id` (identidad de llamada de §3.1 de CONTRATOS) → une llamada, grabación,
  transcripción y evento;
- **transcripción completa**, con quién dijo qué y en qué segundo;
- **captura(s) de la cámara** del portero al momento de atender y al momento de decidir;
- **lo declarado** por el visitante, en campos (nombre, documento, a quién busca, motivo);
- **lo verificado**: qué comprobó el agente y contra qué fuente;
- **la decisión** y su motivo (abrió / llamó al residente / escaló / rechazó);
- **estado de revisión**: pendiente / revisado / marcado como problema.

**Y la bandeja de revisión: es el escritorio de los operarios que ya tenés.**

La pregunta correcta es «¿qué bandeja, si ya tengo operarios?», y la respuesta es que
**son ellos**. Hoy un operario del centro de monitoreo hace esto: suena el portero, atiende,
escucha, decide, y cuando la llamada termina no queda nada más que su memoria. El trabajo
es *atender*, y no escala: dos porteros timbrando a la vez son dos llamadas perdidas o una
persona más.

Con el agente atendiendo, **el mismo operario deja de atender y pasa a mirar**. En la
práctica su pantalla cambia así:

| Hoy | Con el agente |
|---|---|
| Espera que suene y atiende una por una | Ve una lista de lo que pasó, con foto y transcripción al lado de lo declarado |
| Decide en 20 segundos, con lo que escucha | Decide con la ficha del cliente, la captura y lo que el agente ya verificó |
| Su criterio no queda escrito en ningún lado | Su marca («está bien» / «esto no cuadra») queda, y es lo que entrena las reglas |
| Atiende **todas** | Atiende **las que el agente escaló**, que son las difíciles |

O sea: **no es una tarea nueva para nadie, es la misma persona con otra pantalla**, y por eso
la fase 2 no agrega costo de personal — al revés, es la que permite que dos operarios cubran
lo que hoy cubren cuatro. Durante las fases 1 y 2 conviven las dos cosas: el operario sigue
recibiendo las llamadas que el agente escala **y además** revisa lo que el agente resolvió.

Un detalle que decide si esto funciona: **la revisión tiene que llevar segundos**. Si abrir
una visita, ver la foto y marcar cuesta más que haber atendido la llamada, nadie la va a
usar y la evidencia se convierte en un archivo muerto. La pantalla se diseña para eso:
lista, foto grande, tres campos, dos botones.

---

## 4. La pantalla: la nueva solapa «Agente IA» en la cola

En el editor de cola (`Básico` · `Anuncios` · `Avanzado`), una cuarta solapa:

- **Agente**: cuál de `pbxng_ai_agents` atiende esta cola (o «ninguno»).
- **Modo**: `primero` (atiende la IA y escala) · `desborde` (atiende si no hay humano
  disponible en N segundos) · `apagado`.
- **Llamadas simultáneas**: cuántas puede tomar a la vez (= cuántos miembros se registran).
- **Herramientas habilitadas**: las del catálogo, con tildes. `abrir_porton` aparte, con su
  advertencia y sus condiciones.
- **Escalar a**: interno o cola de humanos, y en qué casos (el visitante lo pide, el agente
  duda, el modelo falla, se pasó de N minutos).
- **Horario**: la IA puede atender sólo de noche, que es el caso más probable para arrancar.
- **Prueba en vivo**: un botón que llama a tu interno y te pone al agente del otro lado, con
  la transcripción a la vista. Sin esto, configurar un prompt es a ciegas.

---

## 5. Cómo se despliega sin romper nada (fases)

| Fase | Qué se entrega | Cómo se mide que sirve |
|---|---|---|
| **0 · Laboratorio** | el agente atiende un interno de prueba, sin cola y sin herramientas de escritura | 20 llamadas grabadas y escuchadas a mano: ¿se entiende?, ¿interrumpe bien?, ¿cuánto tarda en contestar? |
| **1 · Acompañante** | modo `desborde` en una cola real de noche; sólo lee, escala siempre | % de llamadas que resolvió sin escalar, y **cero** decisiones de puerta |
| **2 · Evidencia** | registro de visita + captura + transcripción + bandeja de revisión | el supervisor revisa y marca: ¿coincide lo declarado con lo que se ve? |
| **3 · Decisión acotada** | `abrir_porton` **sólo** con visita esperada o autorización del residente en vivo | cada apertura, revisada a mano durante un mes |
| **4 · Reemplazo** | la IA atiende primero en las colas donde la fase 3 anduvo | llamadas por turno que el centro sigue mirando, y en cuántas hizo falta la persona |

**No saltear la fase 2.** Es la que convierte esto de «un bot que atiende» en un producto:
la evidencia es lo que se le muestra al cliente y lo que cubre a la empresa.

---

## 6. Lo que va a doler (dicho ahora, no después)

1. **La latencia manda.** Si el agente tarda más de ~1 s en empezar a responder, la
   conversación se siente rota y la gente cuelga. Medir en Asterisk, no en la API.
2. **El costo es por minuto y por sesión simultánea.** Un portero que timbra 200 veces por
   noche con sesiones de 40 s es tiempo de modelo real. **El tope de llamadas simultáneas es
   un control de gasto, no sólo de capacidad**, y tiene que estar a la vista en el panel.
3. **El audio de telefonía es de 8 kHz** y los modelos esperan 16 o 24. El remuestreo y el
   ruido del portero (calle, lluvia, portazos) degradan la transcripción mucho más que un
   micrófono de escritorio. Es el problema que más va a costar, y no se arregla con prompts.
4. **Privacidad**: se graba, se transcribe y se fotografía a personas que no son clientes.
   Hay que decidir el aviso al visitante, la retención de esas capturas, y quién puede
   verlas. Va escrito en el producto, no en una conversación.
5. **La responsabilidad de abrir una puerta no es un detalle técnico.** Si el agente abre y
   entra quien no debía, la discusión no es sobre el modelo. De ahí la fase 3 acotada y la
   regla del §3.3.
6. **Funcionamiento sin internet.** Una central on-prem que depende de un modelo en la nube
   deja de atender cuando se cae el enlace. El agente tiene que **pausarse solo** y devolver
   las llamadas a los humanos, y eso hay que probarlo cortando el cable a propósito.

---

## 6.1 Fase 0 — qué está hecho y cómo se corre (2026-09-24)

**Hecho y desplegado en pbx01 (1.13.0+):** el puente de voz, que es la pieza que decide si
esto es viable. `control-plane/realtime.js` habla con el modelo por un solo WebSocket,
traduce el audio en los dos sentidos (8 kHz de la telefonía ↔ 24 kHz del modelo), lo
entrega al canal al ritmo de 20 ms que Asterisk espera, maneja el barge-in —tirar lo que
queda por reproducir **y** pedirle al modelo que pare— y **cronometra cada turno**.

Todo lo que el proveedor puede cambiar (nombres de eventos, URL, cabeceras) está en un solo
objeto del archivo. El identificador del modelo NO está en el código: es `model` del agente.

**Lo que falta para correrlo de verdad son dos cosas, y ninguna es código:**

1. **Cargar la clave de OpenAI en el panel** (Configuración → IA / Voz). Hoy pbx01 no tiene
   ninguna, y sin clave el modo realtime **ni se intenta**: la llamada iría a un socket que
   va a fallar y el visitante escucharía silencio.
2. **Un interno de prueba**, con un agente cuyo `provider` sea `openai-realtime`.

**Cómo se corre la fase 0, en orden:**

```
1. Panel → Voz → nuevo agente:
     proveedor = openai-realtime
     modelo    = <el id del modelo realtime vigente>
     voz       = alguna de las del proveedor
     prompt    = escrito a partir de tres llamadas reales del centro (§0)
     interno   = uno de prueba, que no esté en ninguna cola
2. Marcar ese interno desde un softphone.
3. Mientras habla, mirar GET /api/ai-agents/live:
     { sesiones: [ { modo: "realtime", latencia: { turnos, ultimo_ms, mediana_ms, peor_ms } } ] }
```

### ¿Se puede probar gratis?

**No hay plan gratuito para el modelo realtime.** Se paga por token de audio, en los dos
sentidos. Precios publicados al 2026-09-24:

| Modelo | Audio entra | Audio sale |
|---|---|---|
| `gpt-realtime-2.1` | US$ 32 / 1M tokens | US$ 64 / 1M tokens |
| `gpt-realtime-2.1-mini` | US$ 10 / 1M tokens | US$ 20 / 1M tokens |

**Lo que cuesta la fase 0, estimado** (el audio se cuenta a ~10 tokens por segundo, así que
un minuto de conversación con las dos partes hablando la mitad del tiempo son ~600 tokens
de entrada y ~600 de salida):

- con el **mini**: ~US$ 0,02 por minuto → **20 llamadas de un minuto ≈ US$ 0,40**
- con el grande: ~US$ 0,06 por minuto → 20 llamadas ≈ US$ 1,20

O sea: **la fase 0 entera entra en el depósito mínimo de la API (US$ 5) y sobra.** Es una
estimación a partir del precio por token; el número real lo va a decir el tablero de la
cuenta después de las primeras llamadas, y conviene mirarlo ahí antes de hablar de colas.

**Tres caminos que NO cuestan nada, y qué prueba cada uno:**

1. **El modo demo que ya existe** (`provider = demo`): Vosk + reglas + espeak, todo local,
   sin internet y sin clave. **Prueba toda la cañería** —dialplan, AudioSocket, timbrado,
   transferencia, la cola cuando llegue— y **no prueba nada de la conversación**. Sirve
   para dejar el camino armado antes de gastar el primer centavo.
2. **Créditos de Microsoft for Startups**: US$ 1.000 por 90 días (y US$ 4.000 más sin
   inversores, verificación mediante) usables en **Azure**, que sirve los mismos modelos.
   Por eso el endpoint es un ajuste (`realtime_url` en la configuración) y el handshake de
   Azure —que autentica con `api-key` y no con Bearer— ya está contemplado: **cambiar de
   proveedor no puede ser un release**.
3. **Tokens por compartir tráfico**: OpenAI da tokens diarios gratis a quien comparte su
   tráfico de API, pero **requiere saldo positivo** y no está claro que cubra realtime. No
   es un camino para empezar.

**Recomendación:** poner US$ 5 y correr la fase 0 con el **mini**. Si el mini responde
rápido y se entiende, el grande sólo va a estar mejor; y si el mini no alcanza para una
conversación de portería, eso también es información barata.

**El número que decide.** Si la **mediana** pasa de ~1 s, la conversación se siente rota y
la gente cuelga: ahí la respuesta no es cambiar el prompt, es revisar el camino (red de la
central al proveedor, tamaño del colchón, o directamente otro proveedor). Con la mediana
por debajo de eso, se pasa a la fase 1. Veinte llamadas grabadas y escuchadas a mano, como
dice la tabla de fases, y recién después se habla de colas y herramientas.

**Lo que este puente NO hace todavía, a propósito:** no entra a ninguna cola, no tiene
herramientas, no toca el CRM y no abre nada. Eso es fase 1 en adelante.

---

## 7. Lo que queda por decidir

Las otras cuatro están en §0. Queda una, y es la que arranca el trabajo:

**El alcance del piloto: qué cliente, qué portero y qué horario.** Lo que conviene buscar,
por orden: un cliente que ya esté en el CRM con sus unidades cargadas (si no, el agente no
tiene contra qué verificar nada), un portero con cámara que ande y luz de noche, y el turno
nocturno —que es donde más duele cubrir con gente y donde un error tiene menos tránsito—.

Y dos cosas para resolver con ese cliente, no acá: **el aviso al visitante** de que la
llamada se graba y se fotografía, y **cuánto tiempo se guardan** esas capturas.
