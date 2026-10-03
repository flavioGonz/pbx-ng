## Purpose

De dónde salen los clientes y las cámaras que ve un softphone, dónde se guardan los que él
mismo carga, qué se puede ver cuando no hay central, y qué de todo eso se comparte con los
demás que atienden.

## ADDED Requirements

### Requirement: Clientes propios del aparato

El softphone SHALL poder tener clientes cargados en él, con nombre y teléfonos, sin
ninguna central conectada, y SHALL conservarlos entre arranques.

#### Scenario: Se carga un cliente sin central

- **WHEN** el softphone no tiene sesión con ninguna central y se agrega un cliente
- **THEN** el cliente queda guardado en el almacén local cifrado
- **AND** aparece en la lista de clientes marcado como de este teléfono
- **AND** sigue estando después de cerrar y abrir la app

#### Scenario: Se cambia de cuenta SIP

- **WHEN** se cambia a otra cuenta del selector de cuentas
- **THEN** los clientes del sistema se vuelven a pedir a la central de la cuenta nueva
- **AND** los clientes locales SHALL seguir estando, porque son del aparato y no de la
  cuenta

#### Scenario: Se conecta una central

- **WHEN** el softphone inicia sesión con el sistema y la central devuelve su lista
- **THEN** la lista que se muestra es una sola, con los del sistema y los locales, cada uno
  marcado con su origen
- **AND** ningún cliente local SHALL subirse a la central por el solo hecho de haberse
  conectado

### Requirement: Alta manual de una cámara RTSP

Cualquier usuario del softphone SHALL poder agregar una cámara con su URL RTSP, asociada a
un cliente, eligiendo si queda en la central o sólo en el aparato.

#### Scenario: La cámara se manda a la central

- **WHEN** se agrega una cámara a un cliente del sistema y se elige dejarla en la central
- **THEN** la central crea el dispositivo y publica la fuente en su go2rtc
- **AND** la cámara aparece para todos los que atienden en esa central, igual que una
  cargada desde el panel
- **AND** el alta queda registrada con la extensión que la hizo

#### Scenario: La cámara queda en el teléfono

- **WHEN** se agrega una cámara y se elige dejarla sólo en este teléfono
- **THEN** la URL RTSP queda en el almacén local cifrado
- **AND** no se manda a ninguna central
- **AND** la cámara aparece marcada como de este teléfono

#### Scenario: Se agrega una cámara a un cliente local

- **WHEN** el cliente al que se le agrega la cámara es local
- **THEN** la cámara SHALL quedar local también, sin ofrecer el destino central, porque no
  hay cliente del sistema al que colgarla

#### Scenario: La URL no sirve

- **WHEN** lo que se pegó no es una URL de cámara reconocible
- **THEN** se rechaza con el motivo a la vista y nada queda guardado

### Requirement: Mirar una cámara sin central

Una cámara guardada sólo en el aparato SHALL poder verse sin ninguna central conectada, o
SHALL decir por qué no puede, nunca quedar en negro sin explicación.

#### Scenario: Hay con qué reproducirla

- **WHEN** se abre una cámara local y el aparato tiene cómo convertir el RTSP
- **THEN** se muestra el video en vivo, con el mismo visor que las de la central

#### Scenario: No hay con qué reproducirla

- **WHEN** se abre una cámara local y el aparato no puede convertir el RTSP
- **THEN** se muestra el motivo en la propia tarjeta y la acción de subirla a la central
- **AND** NO SHALL mostrarse un reproductor vacío ni un cartel genérico de «sin señal»

### Requirement: La ficha de la llamada mira las dos fuentes

La búsqueda del número de la llamada SHALL mirar los clientes del sistema y los locales.

#### Scenario: El número está sólo en los locales

- **WHEN** entra o sale una llamada con un número que sólo figura en un cliente local
- **THEN** se muestra la ficha de ese cliente y sus cámaras en la pantalla de llamada

#### Scenario: El número está en los dos

- **WHEN** el número figura en un cliente del sistema y en uno local
- **THEN** se muestra el del sistema
- **AND** las cámaras que se ofrecen son las de los dos, las del sistema primero

### Requirement: Lo que el token de aparato puede tocar del CRM

Un softphone enrolado por QR, sin sesión de panel, SHALL poder leer la ficha completa de un
cliente y agregar o quitar dispositivos de ese cliente, y nada más del CRM.

#### Scenario: Se abre la ficha de un cliente

- **WHEN** un softphone con token de aparato pide el detalle de un cliente
- **THEN** la central responde la ficha con sus personas, espacios y dispositivos
- **AND** la pestaña de dispositivos SHALL mostrarlos (hoy dice «Sin dispositivos» por un
  403)

#### Scenario: Se intenta crear un cliente del sistema

- **WHEN** un softphone con token de aparato intenta crear o borrar un cliente de la central
- **THEN** la central lo rechaza
- **AND** el softphone ofrece crearlo local en su lugar
