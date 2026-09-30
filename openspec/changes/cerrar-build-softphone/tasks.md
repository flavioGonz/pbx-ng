# Tasks

## 1. Disparar la compilación por versión

- [ ] 1.1 Agregar al workflow el disparo en `push` a `main` con filtro de ruta
      `softphone-app/package.json`, manteniendo `workflow_dispatch` y el tag.
- [ ] 1.2 Primer paso del job: leer la `version` del `package.json` y consultar si ya
      existe el Release `softphone-v<version>`; si existe, terminar sin compilar.
- [ ] 1.3 Crear el tag desde el workflow al publicar, para que el Release quede anclado a
      un commit y el historial siga siendo legible.
- [ ] 1.4 Probar los tres casos del spec: versión nueva, versión repetida, build fallido.

## 2. Entregar el instalador a la central

- [ ] 2.1 Definir el mecanismo de entrega y su autenticación (es la decisión abierta del
      design). No avanzar con el resto del grupo hasta cerrarlo.
- [ ] 2.2 Implementar la recepción en la central: escribir a temporal, renombrar, y dejar
      el `latest.yml` para el final.
- [ ] 2.3 Borrar versiones viejas dejando la actual y la anterior.
- [ ] 2.4 Probar contra pbx01 con una versión de prueba, y probar el caso de central
      inalcanzable: el Release queda publicado y la central sigue sirviendo la anterior.

## 3. Hacer visible el atraso

- [ ] 3.1 Agregar la fecha de publicación a `/api/softphone/latest` (el dato ya existe en
      el `latest.yml`, falta exponerlo).
- [ ] 3.2 Mostrarlo donde se ve la versión, para que se lea sin entrar por SSH.
- [ ] 3.3 Que el workflow avise cuando hay commits en `softphone-app/` sin cambio de
      versión, que es el caso que nos costó dos días.

## 4. Cierre

- [ ] 4.1 Verificar contra el spec: los tres requisitos con sus escenarios.
- [ ] 4.2 Actualizar la documentación de operación con el flujo nuevo.
- [ ] 4.3 Archivar el cambio con `openspec archive cerrar-build-softphone`.
