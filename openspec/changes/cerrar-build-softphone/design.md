# Design

## Contexto

Hoy hay tres piezas y dos de ellas se accionan a mano:

1. `.github/workflows/softphone.yml` compila en un runner Windows. Se dispara con
   `workflow_dispatch` o con un tag `softphone-v*`.
2. El Release de GitHub queda como respaldo OTA y como origen para las centrales.
3. `docker/fetch-softphone.sh` baja ese Release a `control-plane/softphone/` **sólo cuando
   se arma una imagen nueva de la central** (`docker/release.sh` lo invoca).

El agujero medido: el tag nunca se creó para 0.16.0 ni para 0.17.0, y aunque se hubiera
creado, publicar un Release del softphone no alcanza para que una central que ya está
corriendo lo sirva — hace falta un release de la central o una copia manual.

## Decisiones

### El disparador es la versión, no el tag

El workflow pasa a correr en `push` a `main` cuando cambia `softphone-app/package.json`, y
el primer paso compara la `version` contra los Releases existentes. Si ya hay Release para
esa versión, termina sin hacer nada; si no, compila y publica creando el tag desde el
workflow.

Por qué así y no «compilar en cada push a softphone-app/»: compilar en Windows tarda unos
minutos y no aporta nada si la versión no cambió, porque el OTA compara versiones. Y por
qué no dejarlo sólo en el tag: es justamente el paso que se olvidó.

Se mantiene `workflow_dispatch` para poder recompilar a mano.

### La entrega a la central es push, no pull

La central no sale a buscar. El workflow, ya con el Release publicado, entrega los tres
archivos del feed OTA a cada central registrada.

La alternativa —que cada central consulte periódicamente la API de GitHub— se descarta:
son equipos on-prem en redes de clientes, muchos sin salida libre a internet, y obligaría a
que cada central tenga credenciales de un repo privado el día que deje de ser público.

Queda pendiente de definir en la implementación **cómo** se entrega (el mecanismo de
autenticación contra cada central), porque hoy no existe un endpoint para eso. Es el punto
de mayor riesgo del cambio y conviene resolverlo con una sola central antes de generalizar.

### El atraso se mide contra `main`, no contra el Release

La central no sabe qué hay en `main`. Por eso el estado de distribución se limita a decir
qué versión sirve y desde cuándo, y la comparación contra `main` la hace quien tenga las
dos puntas (el workflow, o el panel si algún día se le da acceso al repo). Así el requisito
de visibilidad no obliga a la central a hablar con GitHub.

## Riesgos

- **Una entrega a medias deja la central sin instalador.** Se escribe a archivo temporal y
  se renombra al final, como ya se hace hoy al copiar a mano; el `latest.yml` se escribe
  último, así nunca apunta a un `.exe` que todavía no está completo.
- **El instalador no está firmado.** No lo cambia esta propuesta, pero automatizar la
  entrega hace que se instale más seguido, y Windows va a seguir mostrando la advertencia
  de editor desconocido. Vale decidir la firma aparte.
- **Disco de la central.** Cada versión suma ~84 MB en `docker/softphone/`. La entrega
  SHALL borrar las versiones viejas dejando la actual y la anterior (pbx01 está al 89%).
