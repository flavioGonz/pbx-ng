# Proposal

> **Escrita después del código.** Este cambio se implementó antes de que el repo adoptara
> OpenSpec (`docs/GUIA-OPENSPEC-Y-GIT.md`). La propuesta, el spec y el diseño documentan lo
> que ya está en el commit de la rama `conexion-con-pbx`, para que quede el porqué al lado
> del código y se pueda revisar en el Pull Request. No es una propuesta a aprobar antes de
> programar.

## Why

El asistente de voz de la portería de Horizon Seguridad vive en otro sistema (el repo
`realtime-voice-poc`): ahí está la lógica de la llamada, es decir, qué decir, cuándo verificar
a una persona, abrir el portón, derivar o cortar. Para atender llamadas reales tiene que
conducir una llamada que entra por la central, y la central no tenía forma de cederle esa
conducción: el agente de IA de la central trae su propio prompt, sus herramientas y su
escalera de inactividad.

Además, en la primera llamada real (29/09) dos derivaciones de la IA se cortaron a los 9 s:
mientras sonaba el interno del agente, quien llamaba escuchaba silencio y el softphone del
panel colgaba solo por su vigilante de RTP.

## What Changes

- **Proveedor nuevo de agente de IA, «IA externa».** La central atiende y pone el audio con
  el mismo puente de siempre a GPT-Live, pero con la configuración de sesión que publica el
  backend del asistente. No usa el prompt, el saludo, las herramientas ni la inactividad del
  agente.
- **Relay de la sesión:** cada evento de GPT-Live va al backend, que solo puede devolver
  frases para decir y el cierre de la sesión.
- **Canal de control con el backend:** la central le cuenta los hechos de la llamada (llamada
  nueva, colgó, DTMF, resultado de la transferencia) y ejecuta sus órdenes (colgar,
  transferir, mandar el DTMF que abre el portón), confirmándolas después de ejecutarlas.
- **Respaldo:** sin backend, sin configuración o sin órdenes, la llamada va al destino de
  respaldo del agente y nunca queda muda.
- **Tono de llamada en las derivaciones:** mientras suena el destino de una transferencia de
  la IA, quien llama escucha el tono de llamada de su país (Uruguay por defecto, configurable).
- **Validación de `ring_time`** de los grupos de timbre (5 a 120 s): entraba crudo al `Dial`.
- **BREAKING** no hay: un agente de IA existente sigue funcionando igual, y las llamadas
  directas entre internos no cambian.

## Capabilities

### New Capabilities

- `ia-externa` — cómo un backend externo conduce una llamada atendida por la central: la
  configuración de la sesión, el relay, el canal de control con sus hechos y órdenes, las
  restricciones de seguridad y el respaldo.
- `tono-de-transferencia` — qué escucha quien llama mientras suena el destino de una
  transferencia sobre un canal ya atendido.

### Modified Capabilities

Ninguna: `openspec/specs/` todavía no tiene capacidades especificadas.

## Impact

- `control-plane/ia-externa.js` (nuevo), `control-plane/ai-pipeline.js` (modo `externo`,
  transferencia con tono), `control-plane/realtime.js`, `control-plane/apps.js` (grupos de
  timbre e IVR), `control-plane/app.js`.
- Migraciones `0029_ia_externa.sql` (proveedor y configuración guardada) y
  `0030_tono_derivaciones.sql` (grupos e IVR existentes).
- Imagen de Asterisk: `indications.conf` nuevo, `extensions.conf`, entrypoint con
  `TONE_COUNTRY`, los dos compose y `.env.example`. **Hay que reconstruir la imagen de
  Asterisk y la API.**
- Panel: pantalla de Agentes IA, con el proveedor y sus campos.
- Contrato: `docs/CONTRATOS.md` §6 (`TONE_COUNTRY`) y §11 (IA externa). El lado del backend
  está en el repo del asistente: la spec `integracion-pbx` y SPEC §74.
