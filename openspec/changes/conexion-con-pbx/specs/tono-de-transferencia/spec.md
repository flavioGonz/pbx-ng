## Purpose

Qué escucha quien llama mientras suena el destino de una transferencia hecha sobre una
llamada que la central ya atendió, como la derivación del agente de IA a un agente humano,
y con qué tono de país suena la central cuando lo genera ella.

## ADDED Requirements

### Requirement: Tono de llamada en la derivación de la IA

Mientras suena el destino de una transferencia del agente de IA, quien llama SHALL escuchar
el tono de llamada, nunca silencio, tanto en la transferencia que ordena el backend como en
cualquiera de los respaldos.

#### Scenario: Derivación a un interno

- **WHEN** la IA transfiere la llamada a un interno registrado y el interno suena
- **THEN** quien llama SHALL escuchar el tono de llamada hasta que el interno atiende
- **AND** la llamada SHALL NOT cortarse por silencio mientras espera, aunque tarde 15 s o más

#### Scenario: Derivación a un grupo de timbre, una opción de IVR o un sígueme

- **WHEN** el destino de la transferencia es un grupo de timbre, una opción de IVR que marca
  un interno o un interno con sígueme
- **THEN** quien llama SHALL escuchar el tono de llamada mientras suena el destino

#### Scenario: Derivación a un interno dormido

- **WHEN** el interno de destino no está registrado y la central lo despierta antes de
  marcarlo
- **THEN** quien llama SHALL escuchar el tono de llamada durante la espera del registro, a
  más tardar desde que termina el pedido de despertar

### Requirement: Llamadas directas sin cambios

Una llamada directa entre internos SHALL seguir como antes: el tono lo arma el teléfono que
llama, a partir del aviso de que el destino está sonando.

#### Scenario: Un interno llama a otro

- **WHEN** un interno llama directamente a otro, sin pasar por la IA
- **THEN** la central SHALL marcar el destino igual que antes del cambio, sin generar ella el
  tono

### Requirement: Tono del país configurable

La central SHALL generar los tonos con los valores del país configurado, Uruguay por
defecto, y SHALL poder cambiarse de país sin reconstruir la imagen cuando el país ya está
incluido.

#### Scenario: País por defecto

- **WHEN** no se configura el país
- **THEN** la central SHALL usar los tonos de Uruguay de la UIT: 425 Hz, llamada 1 s sonando
  y 4 s de silencio, ocupado 0,5/0,5 s y congestión 0,25/0,25 s

#### Scenario: País incluido

- **WHEN** se configura un país incluido (hoy Uruguay y Argentina) y se recrea el
  contenedor de Asterisk
- **THEN** la central SHALL usar los tonos de ese país

#### Scenario: País no incluido

- **WHEN** se configura un país que no está incluido
- **THEN** la central SHALL avisarlo en el log y seguir con el tono de fábrica

### Requirement: Grupos de timbre e IVR existentes

Los grupos de timbre y las opciones de IVR creados antes del cambio SHALL dar tono en una
derivación de la IA igual que los nuevos, sin que haya que volver a guardarlos.

#### Scenario: Migración de una central existente

- **WHEN** se actualiza una central con grupos de timbre e IVR creados por el panel
- **THEN** esos destinos SHALL dar tono en la derivación de la IA
- **AND** SHALL NOT modificarse otras filas del dialplan, y aplicar la migración dos veces
  SHALL dejar el mismo resultado

#### Scenario: Un grupo que no entra en la columna

- **WHEN** el `Dial` de un grupo existente quedaría más largo de lo que admite la columna
- **THEN** ese grupo SHALL quedar como estaba y nombrarse en el log de la migración

### Requirement: Tiempo de timbre de los grupos acotado

El tiempo de timbre de un grupo de timbre SHALL ser un entero de 5 a 120 s, y 25 s si no se
indica.

#### Scenario: Tiempo inválido

- **WHEN** se guarda un grupo con un tiempo de timbre fuera de rango, no entero o con
  caracteres extra como una coma
- **THEN** la central SHALL rechazarlo con 400
