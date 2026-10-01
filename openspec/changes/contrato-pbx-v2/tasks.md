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
      `ultimoSeq`); cada mensaje hacia el backend lleva `seq`; buffer circular de 2000 en la
      sesión. Tests en `test/ia-externa.test.js`: el aviso primero; `seq` de a uno; el buffer
      no pasa del tope.
- [x] 2.2 `ia-externa.js` y `ai-pipeline.js`: las órdenes llegan por el relay, se ejecutan
      solo sobre esa llamada y se confirman por el mismo relay; la cola de ids procesados
      vive en la sesión y sobrevive a una reapertura. Tests: orden ejecutada y ack; orden
      repetida por un relay reabierto; destino no permitido; orden con otro `pbxCallId`.
- [x] 2.3 Hechos por el relay (`colgo`, `dtmf`, `orden_fallida`); con el relay cerrado, por
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

- [ ] 6.1 Prueba en local con el backend v2 (dos instancias y su nginx):
      - llamadas a la vez en instancias distintas;
      - `kill -9` de la instancia de una llamada (se retoma);
      - `SIGTERM` (se reubica);
      - el canal de control caído con una llamada en curso.

      Medir cuánto tarda la reanudación.
- [x] 6.2 `node --test` en `control-plane/` (sin fallos nuevos), lint sin errores,
      `node --check` de los módulos tocados.
      **Avance (01/10):** el `RelayLlamada` real de este repo contra el backend v2 real (compose
      del asistente, dos instancias): con `kill` de la instancia, retomada en la otra a los
      ~0,5 s; con `SIGTERM` (4001), a los ~0,4 s; sin repetir el saludo; y después de retomar,
      la llamada terminó por inactividad con `colgar` por el relay nuevo. Falta la prueba con
      la central entera (Asterisk, ARI y una llamada de verdad).
- [ ] 6.3 Archivar con `openspec archive contrato-pbx-v2`, después de `conexion-con-pbx`.
