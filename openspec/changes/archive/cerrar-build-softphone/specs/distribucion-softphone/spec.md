## Purpose

Cómo llega a la máquina de una persona la versión del softphone que se acaba de commitear:
qué se compila, qué instalador publica cada central y a partir de cuándo esa central se
considera atrasada respecto del código.

## ADDED Requirements

### Requirement: Compilación disparada por la versión

Cada versión de `softphone-app/package.json` que llegue a `main` SHALL producir un
instalador publicado, sin que nadie tenga que crear el tag a mano.

#### Scenario: Se commitea una versión nueva

- **WHEN** un commit en `main` deja `softphone-app/package.json` con una `version` para la
  que todavía no hay Release
- **THEN** se compila esa versión y queda publicada como Release con el `.exe`, su
  `.blockmap` y el `latest.yml`

#### Scenario: Se commitea código sin tocar la versión

- **WHEN** llegan commits a `softphone-app/` pero la `version` no cambia
- **THEN** no se compila nada y no se publica ningún Release
- **AND** el aviso de atraso del requisito «Central atrasada» SHALL activarse, porque hay
  código sin llegar a la gente

#### Scenario: La compilación falla

- **WHEN** el build de una versión falla
- **THEN** no SHALL publicarse ningún Release parcial
- **AND** la central SHALL seguir sirviendo la última versión buena

### Requirement: La central sirve la última versión publicada

Una central SHALL servir en su feed OTA el instalador de la última versión publicada, sin
intervención manual.

#### Scenario: Se publica una versión nueva

- **WHEN** queda publicado el Release de una versión
- **THEN** el feed OTA de la central SHALL ofrecer esa versión
- **AND** un softphone ya instalado SHALL encontrarla al buscar actualizaciones

#### Scenario: La central no se puede alcanzar

- **WHEN** la entrega a una central falla
- **THEN** esa central SHALL seguir sirviendo la versión anterior, completa y consistente
- **AND** el Release SHALL quedar publicado igual, para poder reintentar la entrega sin
  volver a compilar

### Requirement: Central atrasada visible

Una central SHALL poder informar qué versión está sirviendo y desde cuándo, para que
«no hay nada nuevo» se distinga de «nadie publicó lo nuevo».

#### Scenario: Se consulta el estado de distribución

- **WHEN** se pide el estado del softphone publicado
- **THEN** la respuesta SHALL incluir la versión servida y la fecha en que se publicó

#### Scenario: Hay código sin publicar

- **WHEN** la versión en `main` es posterior a la que sirve la central
- **THEN** el estado SHALL marcar que la central está atrasada y nombrar las dos versiones
