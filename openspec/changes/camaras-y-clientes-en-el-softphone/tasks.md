# Tasks

## 1. Arreglar lo que ya está roto

- [x] 1.1 Agregar `GET /api/clients/:id` a `FONO_PERMITIDO` en `control-plane/auth.js`.
- [x] 1.2 Verificar con un token `scope: 'phone'` que el detalle vuelve 200 y trae
      `devices`, y que `POST /api/clients` sigue dando 403.
- [ ] 1.3 Verificar en el softphone que la pestaña «Dispositivos» de un cliente con cámara
      ya no dice «Sin dispositivos».

## 2. Clientes y cámaras guardados en el aparato

- [x] 2.1 `config.js`: el almacén pasa a `{ config, accounts, clientes }`, con migración al
      vuelo de los dos formatos viejos; `getClientesLocales()` / `setClientesLocales()`
      siguiendo el patrón de `getAccounts()` / `setAccounts()`.
- [x] 2.2 Forma de un cliente local: `{ id: 'loc_…', name, phones: [], devices: [] }`, y de
      una cámara local: `{ id: 'loc_…', label, type, rtsp }`. El prefijo `loc_` es lo que
      distingue origen en toda la UI, sin un campo aparte que se pueda perder.
- [x] 2.3 `switchAccount` NO toca `clientes`; `apiDisconnect` tampoco.
- [ ] 2.4 Verificar que los clientes locales sobreviven cerrar/abrir, cambiar de cuenta y
      desconectar del sistema.

## 3. Alta desde la interfaz

- [x] 3.1 Solapa Clientes: botón de agregar cliente. Si hay sesión de panel, pregunta
      «en la central» o «en este teléfono»; si no, va local sin preguntar.
- [x] 3.2 Ficha de cliente, pestaña Dispositivos: botón de agregar cámara, con etiqueta,
      URL RTSP y destino. Validación de la URL antes de guardar.
- [x] 3.3 La lista unificada muestra el origen de cada cliente y de cada cámara.
- [x] 3.4 `api.js`: `clientDeviceAdd(clientId, dev)` y `clientDeviceDel(clientId, devId)`.
- [x] 3.5 `control-plane/auth.js`: abrir los dos verbos de dispositivo acotados al cliente
      de la ruta; `control-plane/app.js`: el alta acepta `rtsp` y publica la fuente en
      go2rtc por el mismo camino que usa el panel.
- [x] 3.6 El alta queda en la bitácora de seguridad con la extensión que la hizo.
- [x] 3.7 Acciones «subir a la central» y «bajar a este teléfono» en una cámara ya cargada.

## 4. Ver las cámaras locales

- [x] 4.1 Decidido: go2rtc empacado en el softphone de escritorio.
- [x] 4.2 `electron/go2rtc-local.cjs` + IPC + `scripts/fetch-go2rtc.sh` + extraResources.
      Probado contra una cámara real: el WebSocket negoció `avc1.640028` y entregó 261 KB
      de fMP4 — el mismo camino que consume el visor. Loopback verificado contra la IP de
      la máquina (rechazado). Config en 600. Reinicia sólo cuando cambia la lista.
- [x] 4.3 Sin Electron (PWA) el visor dice que hace falta el de escritorio o subirla a la
      central, con el motivo a la vista. Android queda igual que la PWA.
- [x] 4.4 Verificar que una cámara que no se puede reproducir muestra el motivo y la acción
      de subirla, nunca un reproductor vacío.

## 5. Cámaras locales en la pantalla de llamada

- [x] 5.1 `camaras` sale de la unión de las dos fuentes, sistema primero.
- [x] 5.2 La búsqueda de la ficha mira los dos lados; empate gana el sistema.
- [ ] 5.3 Verificar con una llamada real a un número que sólo existe en un cliente local.
- [ ] 5.4 Verificar que las cámaras no se remontan al cambiar la principal (la regla de
      `EscenaMedios`: un solo contenedor, `key` estable, sólo cambia la clase CSS).

## 6. Cierre

- [x] 6.1 Subir `softphone-app/package.json` de versión y dejar que CI publique.
- [ ] 6.2 Probar en el softphone de Windows instalado desde el OTA.
- [ ] 6.3 Actualizar el manual del softphone.
- [ ] 6.4 Archivar el cambio en `openspec/changes/archive/`.
