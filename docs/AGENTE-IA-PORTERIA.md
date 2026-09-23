# Agente IA en cola — portería remota atendida por IA

> Estado: **idea ordenada, sin código**. Es el documento para decidir, no un plan aprobado.
> Escrito el 2026-09-23 a partir de la idea del dueño. Lo que está medido dice «medido»;
> lo demás es diseño o estimación y lo dice también.

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

Y una **bandeja de revisión** en el panel: el supervisor ve las visitas del día, con la foto
y la transcripción al lado de lo declarado, y marca. **Esa bandeja es el nuevo trabajo del
centro de monitoreo.** Sin ella, esto es un juguete: la IA atiende, nadie mira, y el día que
se equivoca no hay con qué explicar qué pasó.

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

## 7. Lo que hay que decidir para empezar

1. **Proveedor y modelo realtime**: cuál, y si se acepta que el audio de los visitantes viaje
   a un tercero (cambia la respuesta del punto 4 de arriba).
2. **Alcance del piloto**: ¿qué cliente, qué portero, qué horario?
3. **Idioma y registro**: el agente habla como el centro de monitoreo de hoy — hay que
   escuchar tres llamadas reales y escribir el *prompt* a partir de eso, no al revés.
4. **Quién revisa la bandeja** y con qué frecuencia. Si la respuesta es «nadie», la fase 2 no
   está lista.
5. **Si esto es PBX-NG o un módulo aparte.** Por la regla del producto —*si sin eso algo se
   ROMPE, va en PBX-NG; si con eso algo MEJORA, va en SBC-NG*— el agente de IA **mejora** la
   portería: es un **módulo activable** de PBX-NG (como Portería), apagado de fábrica, que no
   se instala donde no se usa.
