# Tasks

> Se implementa junto con el cambio `contrato-pbx-v2` del repo del asistente: el contrato v2
> reemplaza al v1 y se despliegan juntos. Depende de `conexion-con-pbx`.

## 1. Propuesta y revisión

- [ ] 1.1 Rama `contrato-pbx-v2` desde `conexion-con-pbx`, con esta propuesta, el spec, el
      diseño y las tareas; `openspec validate contrato-pbx-v2 --strict` en verde. Pull
      Request de la propuesta, para que el desarrollador del repo la revise **antes** del
      código (`docs/GUIA-OPENSPEC-Y-GIT.md`).

## 2. El relay v2

- [x] 2.1 `ai-pipeline.js`: el primer mensaje del relay es `llamada_nueva` (con `reanudar` y
      `ultimoSeq`); cada evento y cada hecho hacia el backend lleva `seq` (el aviso y las
      respuestas a órdenes no); buffer circular de 2000 en la sesión. Tests en
      `test/ia-externa-relay.test.js`: el aviso primero; `seq` de a uno; el buffer
      no pasa del tope.
- [x] 2.2 `ia-externa.js` y `ai-pipeline.js`: las órdenes llegan por el relay, se ejecutan
      solo sobre esa llamada y se confirman por el mismo relay; la cola de ids procesados
      vive en la sesión y sobrevive a una reapertura. Tests: orden ejecutada y ack; orden
      repetida por un relay reabierto; destino no permitido; orden con otro `pbxCallId`.
- [x] 2.3 Hechos por el relay (`colgo`, `dtmf`, `transferencia`; `orden_fallida` es la respuesta a una orden y no se numera); con el relay cerrado, por
      HTTP (`POST /api/pbx/llamadas/:pbxCallId/hechos`, con el token y 3 reintentos). Tests:
      por el relay; por HTTP con el relay cerrado; reintento.

## 3. Reanudar y reubicar

- [x] 3.1 Reapertura: si el relay se cierra sin `session.close` ni fin de la llamada,
      reabrir enseguida y después cada 1 s durante `resumeWindowMs`; avisar con
      `reanudar: true`; reenviar desde el `desde` de la confirmación. Respaldo al vencer la
      ventana. Tests con un backend falso: reabre y reenvía en orden; respaldo al vencer;
      `desde` más viejo que el buffer.
- [x] 3.2 Código 4001 ("reubicar"): reabrir sin esperar. Test.
- [x] 3.3 `esperarOrden` (5 s) queda solo para el cierre de la sesión de voz sin orden. Test.

## 4. Canal de control y configuración

- [x] 4.1 `ia-externa.js` (`CanalControl`): solo latido y `refrescar_config`; se quitan las
      órdenes y los hechos de llamadas. Tests en `test/ia-externa.test.js`.
- [x] 4.2 Sin canal de control, una llamada nueva intenta abrir el relay y no va al respaldo
      por eso. Sin configuración bajada, al respaldo como hoy. Tests.
- [x] 4.3 `resumeWindowMs` en la configuración: acotado de 0 a 60 s, 20 s por defecto. Tests.

## 5. Documentación

- [x] 5.1 `docs/CONTRATOS.md` §11 a la v2: mensajes del relay, `seq`, reanudar, 4001,
      hechos por HTTP, canal solo de configuración y `resumeWindowMs`. CHANGELOG
      `[Unreleased]` con el breaking change.

## 6. Integración y cierre

- [x] 6.1 Prueba en local con el backend v2 (dos instancias y su nginx):
      - llamadas a la vez en instancias distintas;
      - `kill -9` de la instancia de una llamada (se retoma);
      - `SIGTERM` (se reubica);
      - el canal de control caído con una llamada en curso.

      Medir cuánto tarda la reanudación.
- [x] 6.2 `node --test` en `control-plane/` (sin fallos nuevos), lint sin errores,
      `node --check` de los módulos tocados.
      **Hecho (01/10) con la central entera** (Asterisk, ARI, llamadas reales del 1001 al 8000,
      backend en dos instancias detrás de su nginx): reanudación a los 24 ms con `SIGTERM` y a los
      26 ms con `kill`, sin volver a saludar; llamadas repartidas entre las dos instancias; el
      canal caído con una llamada en curso no la afecta y se reconecta a la otra en 1 s; el
      hecho tardío de la transferencia se anota. Encontró que una conexión a una instancia
      apagada se colgaba a través del balanceador (14 a 61 s): tope de 3 s para abrir el relay
      y el canal (6.5), y del lado del asistente, tope de conexión en su nginx. Detalle en la
      SPEC del asistente, §85.5.
      **Antes, con el relay solo:** el `RelayLlamada` real de este repo contra el backend v2 real (compose
      del asistente, dos instancias): con `kill` de la instancia, retomada en la otra a los
      ~0,5 s; con `SIGTERM` (4001), a los ~0,4 s; sin repetir el saludo; y después de retomar,
      la llamada terminó por inactividad con `colgar` por el relay nuevo. Falta la prueba con
      la central entera (Asterisk, ARI y una llamada de verdad).
- [x] 6.4 Arreglos de la revisión del agente `revisor` (01/10), con un test de regresión cada
      uno en `test/ia-externa-relay.test.js`: el relay no revive si la llamada termina mientras
      se abre (y cortar un socket que se conecta no tira el proceso); con la llamada terminada
      las órdenes fallan sin ejecutarse; el cierre espera la respuesta de las órdenes en curso
      (con tope); 4001 seguidos no arman un bucle (solo el primer intento de cada corte sale
      sin esperar); latido en el relay (ping cada 2 s, cortado sin respuesta en 6 s); un
      `transferir` inválido no desarma la espera de la orden; sin aviso mandado no se le
      avisa nada al backend; una orden ajena no deja recordado su id; el `session.closed`
      propio no sale después del fin.
- [x] 6.5 Tope de 3 s para abrir el relay y el canal (`handshakeTimeout`): una apertura que el
      balanceador deja colgada contra una instancia apagada se corta y se reintenta. Tests en
      `test/ia-externa-relay.test.js` (un servidor que acepta y nunca contesta).
- [ ] 6.3 Archivar con `openspec archive contrato-pbx-v2`, después de `conexion-con-pbx`.
