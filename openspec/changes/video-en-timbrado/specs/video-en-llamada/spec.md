## Purpose

Qué imagen muestra el softphone en cada momento de una llamada —la del otro lado, o una
cámara del cliente cuando el otro lado no manda imagen—, y qué controles tienen que estar a
la vista encima de esa imagen.

## ADDED Requirements

### Requirement: Mismo comportamiento entrante y saliente

El origen de la imagen y la forma de elegirla SHALL ser los mismos en una llamada entrante y
en una saliente. La dirección de la llamada no SHALL cambiar qué fuentes de video hay.

#### Scenario: El mismo cliente, en los dos sentidos

- **WHEN** hay una llamada con un cliente que tiene cámaras cargadas
- **THEN** las fuentes de video disponibles SHALL ser las mismas, la haya originado el
  usuario o el cliente

### Requirement: Las cámaras del cliente durante el timbrado

Mientras timbra una llamada entrante de un cliente con cámaras, esas cámaras SHALL verse,
para poder decidir si se atiende mirando lo que pasa del otro lado.

#### Scenario: Llama un portero sin video

- **WHEN** entra una llamada de un cliente con cámaras y la llamada no anuncia video
- **THEN** la primera cámara del cliente SHALL ocupar la pantalla principal mientras timbra
- **AND** el resto SHALL aparecer como miniaturas seleccionables

#### Scenario: La llamada entrante anuncia video

- **WHEN** entra una llamada que anuncia video
- **THEN** las cámaras del cliente NO SHALL encenderse durante el timbrado
- **AND** al atender, la imagen de la llamada SHALL ocupar la pantalla principal

#### Scenario: La llamada se atiende

- **WHEN** se atiende una llamada que ya mostraba una cámara del cliente
- **THEN** esa cámara SHALL seguir viéndose sin cortarse ni reiniciarse
- **AND** si llega imagen del otro lado, esa imagen SHALL pasar a la pantalla principal,
  salvo que el usuario haya elegido una fuente a mano

#### Scenario: La llamada termina sin atenderse

- **WHEN** se rechaza la llamada, o deja de timbrar sin atenderse
- **THEN** las cámaras SHALL dejar de consumirse

### Requirement: Los controles de la llamada entrante siempre a la vista

Mientras timbra una llamada entrante SHALL poder atenderse y rechazarse, haya o no imagen en
pantalla.

#### Scenario: Timbra con imagen en pantalla

- **WHEN** timbra una llamada entrante y hay una cámara ocupando la pantalla
- **THEN** atender, atender con video y rechazar SHALL estar visibles sobre la imagen
- **AND** quién llama SHALL estar identificado en pantalla

### Requirement: La cámara propia antes de atender

La miniatura con la cámara propia SHALL encenderse desde que timbra la llamada entrante.

#### Scenario: Entra una llamada

- **WHEN** empieza a timbrar una llamada entrante
- **THEN** la miniatura propia SHALL mostrar la cámara del usuario

#### Scenario: Se atiende con video

- **WHEN** se atiende con video una llamada cuya cámara propia ya estaba encendida
- **THEN** la llamada SHALL usar esa misma cámara sin pedirla de nuevo al sistema

#### Scenario: La cámara no está disponible

- **WHEN** no hay cámara, el permiso está denegado, o el dispositivo está ocupado por otra
  aplicación
- **THEN** la llamada SHALL seguir funcionando y SHALL poder atenderse
- **AND** la miniatura propia SHALL decir en palabras por qué no hay imagen
