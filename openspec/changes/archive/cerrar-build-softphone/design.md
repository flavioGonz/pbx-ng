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

### La entrega a la central es pull, no push — REVISADO al implementar

**Decisión original (descartada):** la central no sale a buscar; el workflow le entrega los
tres archivos del feed OTA a cada central registrada. El argumento era que son equipos
on-prem, muchos sin salida libre a internet.

**Decisión final: pull.** La central consulta el Release y baja el instalador. Al ir a
implementar el push aparecieron tres cosas que lo vuelven la peor de las dos opciones:

1. **Las centrales están detrás de NAT.** Para que GitHub Actions les entregue algo hay que
   darle a CI un camino ENTRANTE a cada una. Eso es justamente lo que un cliente on-prem no
   da, y es la superficie más peligrosa de todo el cambio: un endpoint de administración
   publicado en cada PBX, con una credencial de larga vida guardada en los secretos del
   repo, a cambio de no consultar una URL.
2. **El argumento contra el pull no se sostiene.** La central ya necesita salida HTTPS para
   Let's Encrypt (`acme.js`). Y si de verdad no tiene salida, el push tampoco la salva: no
   le llega nada igual.
3. **Para la central sin salida, la respuesta honesta es otra:** subir el archivo a mano
   desde el panel. Es un camino que conviene tener de todas formas y no requiere ni push ni
   pull. (Queda como tarea aparte: hoy se sube por SSH al directorio montado.)

El pull atraviesa NAT sin abrir nada, no necesita credencial mientras el repo sea público, y
degrada bien: si no se llega a GitHub la central sigue sirviendo la versión que ya tiene.

Nace **apagado**. Prender una salida a internet periódica en el equipo telefónico de un
cliente es una decisión de quien administra esa central, no un default que llega con una
actualización.

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
