# Tasks

## 1. Las cámaras del cliente durante el timbrado

- [x] 1.1 En `App.jsx`, dejar de excluir `entrante` de `camsEnLlamada`; excluir sólo
      `finCall` y el caso de llamada entrante que anuncia video (`sp.incomingVideo`).
- [x] 1.2 Verificar que al atender la cámara no se corta ni se reinicia: el componente de
      la fuente no debe desmontarse al cambiar de estado. **Verificado por inspección**:
      `EscenaMedios` dibuja cada fuente con `key={f.id}`, así que al aparecer la fuente
      `llamada` al atender, React reconcilia las cámaras por su clave y no las remonta.
- [ ] 1.3 Verificar que al rechazar y al vencer el timbrado se dejan de consumir las
      cámaras.

## 2. Los controles de la entrante, sobre el video

- [x] 2.1 En `CallScreen.jsx`, sacar del bloque que se oculta los redondos de atender,
      atender con video y rechazar cuando el estado es `entrante` y hay escena de video.
- [x] 2.2 Mostrar sobre el video quién llama y la ficha del CRM mientras timbra.
- [x] 2.3 Que los controles no se escondan solos mientras timbra: el ocultamiento
      automático es para la llamada en curso. **Ya era así**: el efecto que los esconde
      sólo corre con `hablando`. Además la barra inferior no existe en `entrante`
      (`conBarra`), por eso el bloque nuevo trae su propio degradado.
- [ ] 2.4 Probar en ventana angosta: los tres redondos y la ficha tienen que entrar sin
      taparse entre sí. Se agregó el escenario **Entra+cam** a `?demo=call` para poder
      mirarlo sin levantar una llamada; falta pasarlo en una ventana chica de verdad.

## 3. La cámara propia antes de atender

- [ ] 3.1 Resolver primero si el motor nativo puede recibir una pista ya abierta. Si no
      puede, la previa queda sólo en WebRTC y se anota acá por qué. **Es la decisión
      abierta del design; no avanzar con 3.2 sin cerrarla.**
- [ ] 3.2 Abrir la previa al empezar a timbrar y mostrarla en la miniatura propia.
- [ ] 3.3 Entregarle esa misma pista a la sesión al aceptar con video.
- [ ] 3.4 Liberarla al rechazar, al vencer el timbrado y al aceptar sin video.
- [ ] 3.5 Caso sin cámara, permiso denegado o dispositivo ocupado: la llamada se atiende
      igual y la miniatura dice por qué no hay imagen.

## 4. Cierre

- [ ] 4.1 Verificar los cuatro requisitos del spec con sus escenarios, con una llamada real
      del portero de un cliente y con una llamada entre internos.
- [ ] 4.2 Subir la versión del softphone y confirmar que el build automático publica sola la
      versión nueva (verifica de paso el escenario pendiente de `cerrar-build-softphone`).
- [ ] 4.3 Archivar el cambio con `openspec archive video-en-timbrado`.
