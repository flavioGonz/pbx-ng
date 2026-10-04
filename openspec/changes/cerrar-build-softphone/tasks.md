# Tasks

## 1. Disparar la compilación por versión

- [x] 1.1 Agregar al workflow el disparo en `push` a `main`, manteniendo `workflow_dispatch`
      y el tag. **Sin filtro de ruta**: se evaluó `paths: ['softphone-app/**']` y se
      descartó porque un `paths` se comporta distinto con merge commits, force push y
      tags, y este cambio existe justamente porque algo no corrió y nadie se enteró. El
      filtro pasa a ser un job `decidir` en Linux, de unos segundos, que además deja
      escrito por qué compiló o por qué no.
- [x] 1.2 Job `decidir`: lee la `version` del `package.json` y consulta si ya existe el
      Release `softphone-v<version>`. El job `build` corre sólo si no existe.
      `workflow_dispatch` acepta `forzar` para recompilar igual.
- [x] 1.3 El tag lo crea el paso de publicación desde la versión (`tag_name`), no una
      persona.
- [ ] 1.4 Probar los tres casos del spec: versión nueva, versión repetida, build fallido.
      - **Versión repetida: verificado.** El merge del grupo 1 a `main` disparó la
        ejecución #10: `decidir` terminó en éxito y `build` quedó en *skipped*, porque ya
        existe el Release `softphone-v0.17.0`. Es el caso «se commitea código sin tocar la
        versión» del spec.
      - **Build fallido: verificado por inspección.** Ningún paso tiene
        `continue-on-error`, así que un build fallido corta el job antes del paso de
        publicación y no deja Release parcial.
      - **Versión nueva: pendiente.** Se verifica solo la próxima vez que suba la versión
        del softphone por un cambio real; no se fuerza una versión para probar.

## 2. Entregar el instalador a la central

- [x] 2.1 Definir el mecanismo de entrega y su autenticación (es la decisión abierta del
      design). No avanzar con el resto del grupo hasta cerrarlo.
- [x] 2.2 Implementar la recepción en la central: escribir a temporal, renombrar, y dejar
      el `latest.yml` para el final.
- [x] 2.3 Borrar versiones viejas dejando la actual y la anterior.
- [x] 2.4 Probado contra pbx01: descarga forzada de 0.17.0, 84 MB en 11 s, 0.15.0 podada,
      0.16.0 conservada como anterior, `latest.yml` reescrito al final. El caso «no se
      llega a GitHub» queda en warn y la central sigue sirviendo lo que tiene.
- [x] 2.5 Guarda de rol: `/api/softphone/ota*` sólo admin (verificado 403 con rol
      operador); `/api/softphone/latest` sigue público, que es lo que lee el login.
- [x] 2.6 Freno de disco: por debajo de 600 MB libres no se baja nada, porque dejar sin
      espacio el disco de una central corta llamadas y una versión del softphone no vale eso.
- [ ] 2.7 Subida manual del instalador desde el panel, para la central sin salida a
      internet (hoy se sube por SSH al directorio montado).

## 3. Hacer visible el atraso

- [x] 3.1 Agregar la fecha de publicación a `/api/softphone/latest` (el dato ya existe en
      el `latest.yml`, falta exponerlo).
- [x] 3.2 Mostrarlo donde se ve la versión, para que se lea sin entrar por SSH.
- [ ] 3.3 Que el workflow avise cuando hay commits en `softphone-app/` sin cambio de
      versión, que es el caso que nos costó dos días.

## 4. Cierre

- [ ] 4.1 Verificar contra el spec: los tres requisitos con sus escenarios.
- [ ] 4.2 Actualizar la documentación de operación con el flujo nuevo.
- [ ] 4.3 Archivar el cambio con `openspec archive cerrar-build-softphone`.
