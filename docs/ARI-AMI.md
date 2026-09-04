# Dónde usa PBX-NG ARI y dónde AMI

Asterisk expone dos interfaces de control y el control-plane (`control-plane/app.js`) usa
las dos. Conviene tener claro qué depende de cada una, porque fallan distinto y se
diagnostican distinto.

| Interfaz | Puerto | Cliente | Para qué la usamos |
|---|---|---|---|
| **AMI** (Asterisk Manager Interface) | 5038/TCP | `asterisk-manager` | Eventos en vivo, acciones puntuales y CLI encapsulada (`Action: Command`). Reconecta sola (`keepConnected`). |
| **ARI** (Asterisk REST Interface + WebSocket) | 8088/TCP (`/ari`) | `ari-client` | Control de llamadas con estado propio: la app Stasis `pbxng`, bridges, canales de medios externos. Desde 1.3.0 reconecta con backoff (2 s → 30 s). |
| **AudioSocket** | 9092/TCP (escucha la API) | `ai-pipeline.js` | Audio crudo de la llamada hacia el pipeline STT → LLM → TTS del IVR con IA. Lo abre Asterisk vía ARI `externalMedia`. |

## Lo que depende de ARI

Hay una sola aplicación Stasis, `pbxng`, con dos "sub-apps" por argumento:

- **IVR con IA** (`Stasis(pbxng,ai,<agentId>)`, insertado en el dialplan realtime por
  `aiAgentDialplan`): al entrar la llamada, `handleAiAgent` la atiende y `ai-pipeline.js`
  arma un bridge *mixing* + un canal `externalMedia` (AudioSocket) hacia la API. La
  transferencia desde el agente (`transfer_call`) usa `channel.continueInDialplan`.
- **Conferencia a 3** (`POST /api/calls/conference`): bridge *mixing* con la llamada activa
  del interno más una pata originada con `appArgs: 'conf'`.
- **Presencia de internos y agentes** (`endpointStates()` → `ari.endpoints.list()`): alimenta
  `/api/directory`, `/api/presence`, el estado de los agentes de cola y el `snapshot` que
  reciben las pantallas por socket.io.
- **Llamadas activas** (`getChannels()` → `ari.channels.list()`): canales que muestran el
  Resumen, Topología, Monitor y Wallboard.
- **Grabación bajo demanda** (`POST /api/calls/record`): ARI sólo *ubica* el nombre del canal;
  la grabación la hace AMI (`MixMonitor`). Desde 1.3.0, si ARI no responde, el canal se busca
  por AMI (`core show channels concise`), así la grabación no depende de ARI.

## Lo que depende de AMI

- **Eventos en vivo** (`managerevent`): `Newchannel`/`Hangup`/`Newstate`/`DeviceStateChange`/
  `ContactStatus`/`QueueMember*`/`QueueCaller*` disparan el refresco del panel; `DialBegin`
  manda el **Web Push** de llamada entrante a la PWA; `DialEnd` con `NOANSWER/BUSY/CANCEL`
  genera el aviso de **llamada perdida** (Telegram/WhatsApp); `hangup` dispara el
  **indexado de grabaciones**.
- **Supervisión** (escucha / susurro / irrupción): `Originate` con `ChanSpy`.
- **Grabar en vivo**: `MixMonitor` / `StopMixMonitor`. Flags "grabar siempre" en AstDB (`DBPut`/`DBDel`).
- **Call center**: `QueuePause`. **Aparcado**: `ParkedCalls`. **Colgar desde el panel**: `Hangup`.
- **Reloads** tras cambios generados por el panel: `module reload res_parking.so`,
  `module reload res_pjsip.so` (grupos de captura), `moh reload`.
- **Consola CLI de sólo lectura** del panel (`Action: Command` con lista blanca `CLI_ALLOW`).
- **Estado de troncales**: `pjsip show registrations` / `pjsip show contacts`.

## Qué pasa si se cae cada una

- **Sin AMI**: no hay eventos → el panel deja de refrescarse solo, no salen push de llamada
  entrante ni avisos de perdidas, no se puede grabar/espiar/pausar. `amiCommand` devuelve
  vacío y los reloads responden `ok` sin haber recargado. AMI reconecta sola.
- **Sin ARI**: todos los internos aparecen `offline`, 0 llamadas activas, la conferencia a 3
  responde `503`, el IVR con IA cuelga (`ai-pipeline` no tiene cliente) y el servidor
  AudioSocket no se inicializa hasta que ARI vuelva. Hasta 1.2.x ARI se conectaba **una sola
  vez** al arrancar: si la API levantaba antes que Asterisk, quedaba muerta hasta reiniciar
  el contenedor. Desde 1.3.0 (`connectAri`) reintenta con backoff, escucha `WebSocketClose` /
  `WebSocketError` y al reconectar vuelve a inicializar el pipeline de IA.

`/health` y el `snapshot` exponen `{ ari, ami }`; `alerts.js` avisa por correo cuando alguna
de las dos cae. La sonda de salud del núcleo (`salud.js`) abre el puerto **8088**, es decir
prueba el HTTP de ARI, no AMI.

## Motor de llamadas (1.3.1+, `control-plane/callengine.js`)

Desde 1.3.1 el control de llamadas tiene un módulo propio sobre ARI:

- **Estado por eventos, no por polling.** La API arranca la app Stasis con `subscribeAll`
  (`ari.start('pbxng', true)`), así recibe `ChannelCreated`/`ChannelStateChange`/
  `ChannelDestroyed`/`EndpointStateChange` de toda la central y mantiene una cache de
  canales y endpoints. `getChannels()` y `endpointStates()` leen esa cache; el panel se
  refresca al instante por `broadcastSoon()` y queda un reconciliado cada 15-20 s por si
  se perdió algo (reconexión, arranque).
- **Control por API** (`/api/calls/*`, con sesión): `POST /dial {from,to}` (click-to-dial:
  suena el interno y al atender marca el destino por el dialplan), `POST /:id/hangup`,
  `/:id/hold`, `/:id/unhold`, `POST /transfer {ext,to}` (a ciegas: redirige al *otro*
  extremo de la llamada de `ext`), `POST /park {ext}` (al lote de aparcado), `GET /live`.
- **Supervisión con estado real** (`POST /spy {sup,target,mode}` → `{id}`,
  `DELETE /spy/:id`, `GET /spy`): `snoopChannel` sobre el canal del agente (spy both;
  whisper `none`/`out`/`both` = escucha / susurro / irrupción) + bridge propio + el
  supervisor originado a Stasis. La sesión se cierra sola si la llamada termina. Sin ARI
  se cae al `Originate`+`ChanSpy` por AMI de siempre.

Pendiente en esta línea: transferencia atendida, grabación por ARI (`snoop` + `record`),
eventos de cola por ARI, y sobre esta base la IA en vivo (transcripción, coaching).

## Solapamientos que conviene saber

- (Resuelto en 1.3.1) Presencia y llamadas activas ya no se encuestan cada 3 s: llegan por eventos ARI.
- (Resuelto en 1.3.1) La supervisión ya no es `Originate`+`ChanSpy` a ciegas: es `snoopChannel` con sesión.
- Hay tres mecanismos de mezcla conviviendo: bridges ARI (conferencia a 3 y IA), `confbridge`
  (salas de conferencia del dialplan) y `ChanSpy`. Funcionan; sólo es bueno tenerlo presente
  antes de agregar un cuarto.
