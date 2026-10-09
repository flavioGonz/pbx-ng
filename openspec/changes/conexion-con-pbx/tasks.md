# Tasks

> Los grupos 1 a 3 ya están implementados en el commit de la rama `conexion-con-pbx`; este
> archivo se escribió después del código (ver proposal.md). Lo que queda abierto es el
> despliegue y la verificación en una central real.

## 1. IA externa: el backend conduce la llamada

- [x] 1.1 Proveedor `ia-externa` en `pbxng_ai_agents` y tabla `pbxng_ia_externa_config`
      (migración 0029). Validación al guardar: URL http(s), token, al menos un destino,
      DTMF `0-9 * # A-D`. Verificado con `test/ia-externa-api.test.js`.
- [x] 1.2 Canal de control (`ia-externa.js`): hechos, órdenes con ack después de ejecutar,
      repetidas sin re-ejecutar, destinos limitados, solo llamadas propias, latido de 15 s,
      reconexión 1/2/5/10 s y 60 s con token rechazado. Configuración con ETag, guardada
      en la base, rechazada si no es GPT-Live. Verificado con `test/ia-externa.test.js`.
- [x] 1.3 Modo `externo` de `ai-pipeline.js` y relay en `realtime.js`: sesión con la
      configuración del backend, eventos hacia el backend, solo tres tipos hacia la sesión,
      espera de la cola de audio antes de colgar o transferir, respaldo sin backend, sin
      configuración, sin enganche o sin orden en 5 s. Verificado con
      `test/ia-externa.test.js` y con llamadas locales del softphone al backend.
- [x] 1.4 Panel: el proveedor y sus campos en la pantalla de Agentes IA. Verificado a mano
      creando el agente en una central local.
- [x] 1.5 Documentación: `docs/CONTRATOS.md` §11, `docs/AGENTE-IA-PORTERIA.md` §8 y
      CHANGELOG.

## 2. Tono de llamada en las derivaciones

- [x] 2.1 `indications.conf` con `uy` y `ar` de la UIT en la imagen de Asterisk, y
      `TONE_COUNTRY` en el entrypoint, los dos compose y `.env.example`. Verificado con
      `test/imagen-asterisk.test.js` e `indication show` en la central local.
- [x] 2.2 `DIAL_OPCIONES=r` en la transferencia y en el respaldo; los `Dial` del interno,
      del sígueme, de los grupos de timbre y de las opciones de IVR la leen, y `Ringing()`
      antes de despertar a un interno. Verificado con `test/telefonia.test.js` y en vivo:
      derivación atendida a los 15 s, con tono y sin corte.
- [x] 2.3 Migración 0030 para los grupos e IVR existentes: solo la forma exacta que
      escribía el panel, idempotente, y nombra en el log lo que no entra. Verificado con
      `test/migracion-tono.test.js`.
- [x] 2.4 `ring_time` de los grupos de timbre, de 5 a 120 s, con 400 si no. Verificado con
      `test/telefonia.test.js`.
- [x] 2.5 Documentación: `docs/CONTRATOS.md` §6 (`TONE_COUNTRY`) y §11, y CHANGELOG.
- [x] 2.6 El video del portero llega al agente: el puente de la IA pasa a `mixing,video_sfu`
      (design.md, decisión 9) y la imagen verifica `bridge_softmix.so`. Verificado con
      `test/puente-ia.test.js` y en vivo: con el registro SIP, el re-INVITE con `m=video 0`
      ya no sale y el INVITE al 1002 lleva `m=video`; el 1002 vio la cámara del 1001.

## 3. Revisión

- [x] 3.1 Rebase sobre `main` sin conflictos. `node --test` en `control-plane/`: los mismos
      7 fallos que ya tenía `main` y ninguno nuevo; lint sin errores; `node --check` de
      los módulos tocados.
- [x] 3.2 Pull Request de `conexion-con-pbx` hacia `main`, revisado y aprobado por la otra
      persona del repo. **Descartada (02/10):** no se hace un PR propio; todos los commits de
      `conexion-con-pbx` están en `contrato-pbx-v2`, que va a `main` en su PR. La rama
      `conexion-con-pbx` se borró.

## 4. Despliegue y verificación en una central real

- [ ] 4.1 Desplegar en pbx01: reconstruir la imagen de Asterisk y la de la API, y
      confirmar con `indication show` que está la zona `uy`.
- [ ] 4.2 Crear el agente «IA externa» apuntando al backend y verificar en el log que baja
      la configuración y que el canal de control queda conectado.
- [ ] 4.3 Llamada real por pbx01: el asistente atiende, abre el portón con el DTMF y deriva
      a un agente con tono de llamada. Medir la latencia de la respuesta y del corte por
      interrupción.
- [ ] 4.4 Verificar contra los specs `ia-externa` y `tono-de-transferencia`, y archivar con
      `openspec archive conexion-con-pbx`.
