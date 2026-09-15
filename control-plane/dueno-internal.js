'use strict';
/* ============================================================================
 *  PBX-NG · ¿Quién ocupa esta extensión del contexto `internal`?
 *
 *  `internal` es un contexto COMPARTIDO: ahí conviven los códigos de función de
 *  telefonia.js (`*97` y compañía), las rutas salientes de trunks.js, las salas,
 *  los abreviados globales y las cuatro aplicaciones de marcacion.js. Y todos publican
 *  igual: `setDialplan()` es DELETE + INSERT por (contexto, extensión), así que el que
 *  escribe último se lleva puesto al anterior EN SILENCIO —una DISA en `*97` borraba el
 *  buzón de voz y nadie se enteraba hasta que un usuario se quejaba—.
 *
 *  POR QUÉ ESTO ESTÁ EN UN ARCHIVO APARTE Y NO EN CADA MÓDULO: el candado sólo sirve si lo
 *  cierran los DOS lados. Cuando la comprobación vivía dentro de marcacion.js, la DISA ya
 *  no podía pisar un código de función, pero publicar el código de función seguía borrando
 *  la DISA: el mismo error en espejo. Y duplicar la lista de tablas en cada módulo es
 *  garantizar que dentro de tres sprints uno de los dos quede viejo (el que se olvide de
 *  agregar la tabla nueva vuelve a pisar sin avisar). Acá está la lista ÚNICA de quién
 *  puede ocupar una extensión de `internal`; el módulo que empiece a publicar ahí se
 *  agrega en `DUENOS` y los dos lados se enteran solos.
 *
 *  Lo usan los TRES módulos que publican en `internal`: `marcacion.js` (DISA, callback,
 *  directorio por nombre, abreviados globales), `telefonia.js` (códigos de función) y
 *  `trunks.js` (rutas salientes y la salida directa de cada troncal).
 *  Hasta 1.10.0 los dos últimos escribían y borraban a ciegas y el candado NO era simétrico:
 *  se borraba una ruta saliente `_*21*.`, el admin publicaba un código de función en ese
 *  mismo número porque ya no había dialplan, y al recrear la ruta `setDialplan()` (DELETE +
 *  INSERT) se llevaba puesto el código sin que nadie se enterara.
 *
 *  No registra rutas ni abre conexiones: recibe el cliente de la transacción en curso,
 *  porque quien pregunta está siempre a punto de escribir y la respuesta tiene que valer
 *  dentro de esa misma transacción.
 * ==========================================================================*/

/* El `_` inicial es cosa del dialplan (pbx_realtime sólo corre ast_extension_match sobre
 * las filas que empiezan con `_`), no de la identidad del número: `*21*.` y `_*21*.` son
 * el MISMO código de función. `pbxng_featurecodes.code` se guarda como lo escribió el
 * administrador —con `_` o sin él, el `CODE_OK` de telefonia.js acepta las dos formas— y
 * la semilla de fábrica lo guarda CON `_`, así que comparar en crudo daba falsos
 * negativos justo del lado que importa: preguntar por `code=$1 OR code='_'||$1` dejaba
 * pasar una DISA encima de un código guardado sin guión bajo. Se normaliza siempre de los
 * dos lados y listo. */
const sinGuion = (v) => String(v == null ? '' : v).replace(/^_/, '');

/* Las tablas que publican una extensión en `internal`, con el texto que ve el
 * administrador y la columna que identifica la fila (para reconocer «ésta es la mía, la
 * estoy editando»). Los nombres salen de acá y NUNCA del pedido: se interpolan en el SQL
 * porque un identificador no se puede parametrizar. */
const DUENOS = [
  { familia: 'disa', tabla: 'pbxng_disa', col: 'exten', clave: 'id', filtro: '', que: 'una DISA' },
  { familia: 'callback', tabla: 'pbxng_callback', col: 'exten', clave: 'id', filtro: '', que: 'un callback' },
  { familia: 'dialbyname', tabla: 'pbxng_dialbyname', col: 'exten', clave: 'id', filtro: '', que: 'el directorio por nombre' },
  { familia: 'abreviado', tabla: 'pbxng_abreviados', col: 'code', clave: 'id', filtro: ' AND ext IS NULL', que: 'otro número corto' },
  /* La PK del catálogo de códigos de función es la ACCIÓN, no el código: el administrador
   * puede mover «no molestar» de `*78` a `*38` sin que deje de ser no molestar. */
  { familia: 'featurecode', tabla: 'pbxng_featurecodes', col: 'code', clave: 'accion', filtro: '', que: 'un código de función' },
  /* Rutas salientes (`trunks.js`): el PATRÓN es la extensión. Se guarda sin `_` en la tabla y
   * con `_` en `extensions`; `sinGuion` normaliza los dos lados, igual que con los códigos. */
  { familia: 'outbound', tabla: 'pbxng_outbound_routes', col: 'pattern', clave: 'id', filtro: '', que: 'una ruta saliente' },
  /* La salida directa de una troncal (`writeAsteriskTrunk` de `trunks.js`): con «crear ruta
   * de salida automática» encendido, dar de alta una troncal publica `_<prefijo>.`. No tiene
   * tabla propia —la fila que lo reclama es la troncal— y el prefijo vive en su `adv_config`,
   * así que la columna es una expresión.
   *   El `kind='asterisk'` NO es decorativo: es el conjunto exacto que pasa por
   * `writeAsteriskTrunk`. Sin él, el `COALESCE(..., 'X')` convertía a TODA troncal sin
   * `outbound_prefix` en dueña fantasma de `_X.` —el enlace `to-sbc` y las troncales
   * WebRTC, que no publican una sola línea de dialplan—, y en una central con SBC eso
   * dejaba sin poder crear una ruta saliente con patrón `X.` ni guardar una troncal con el
   * prefijo vacío (que es «marcá sin prefijo»), con un 409 que mandaba a arreglar el
   * formulario de un enlace que ni siquiera tiene campo de prefijo. */
  { familia: 'troncal', tabla: 'pbxng_trunks', clave: 'name', que: 'la salida directa de una troncal',
    col: "('_' || COALESCE(NULLIF(adv_config->>'outbound_prefix', ''), 'X') || '.')",
    filtro: " AND COALESCE(kind, 'asterisk')='asterisk'"
      + " AND COALESCE((adv_config->>'outbound_enabled')::boolean, true)" },
];

/* La firma que deja cada familia de marcacion.js en la PRIMERA fila del dialplan que
 * publica: es lo que permite reconocer una extensión propia sin agregarle una columna a la
 * tabla realtime de Asterisk. Los códigos de función NO tienen firma —cuatro de ellos
 * (`*43`, `*65`, `*97`, `*98`) heredaron el dialplan pelado de apps.js, que arranca en
 * `Answer`, y hay centrales con eso ya publicado—: a ésos los reconoce el catálogo, ver
 * `reclamos()`. */
const MARCA = {
  disa: 'DISA ',
  callback: 'Callback ',
  dialbyname: 'Directorio por nombre',
  abreviado: 'Abreviado ',
  /* `filasSalida()` de trunks.js abre SIEMPRE con `NoOp(ruta <id>: …)` —antes lo escribía
   * sólo cuando la ruta tenía respaldos y por eso la ruta de una sola troncal no se podía
   * reconocer—. La firma identifica a la FAMILIA, no a la ruta: alcanza para saber que ese
   * dialplan lo publicaron las rutas salientes y no otra aplicación. */
  outbound: 'ruta ',
  troncal: 'Salida ',
};

/* ¿Esta fila del dialplan la publicó `familia`? */
function esFilaPropia(familia, fila) {
  if (!fila || fila.app !== 'NoOp') return false;
  const m = MARCA[familia];
  return !!m && String(fila.appdata || '').startsWith(m);
}

const err409 = (msg) => Object.assign(new Error(msg), { status: 409 });

/* Qué tablas dicen tener ese número, con la clave de la fila que lo tiene. Se consultan
 * TODAS (no se corta en la primera): hace falta saber si además de la mía hay otra. */
async function reclamos(c, exten, familia, propio) {
  const ex = sinGuion(exten);
  const out = [];
  if (!ex) return out;
  for (const d of DUENOS) {
    /* «La mía ÚLTIMA», y el orden importa en ese sentido y no en el otro. El `LIMIT 1` sin
     * orden devolvía una fila cualquiera de las que reclaman el número, así que quién
     * quedaba bloqueado dependía del orden físico de la tabla: dos troncales dadas de alta
     * sin tocar el prefijo quedan las dos en `_0.` (es el default de fábrica) y guardarle
     * un cambio a una de ellas —la clave o el host, durante una caída del operador, justo
     * cuando hay apuro— podía devolver 409 para siempre.
     *   Lo intuitivo sería poner la propia PRIMERO, y está mal: con `LIMIT 1` la fila
     * propia TAPA a la ajena y el choque de verdad pasa sin que nadie lo vea (el alta de
     * una troncal inserta su fila antes de publicar el dialplan, así que siempre hay una
     * fila propia que mirar). Poniéndola última, si hay otro aparece el otro —409 con su
     * nombre— y si el único que reclama soy yo, aparezco yo y el guardado pasa. */
    const propioDe = d.familia === familia && propio != null ? String(propio) : null;
    const { rows } = await c.query(
      'SELECT ' + d.clave + ' AS clave FROM ' + d.tabla + ' WHERE ltrim(' + d.col + ", '_')=$1" + d.filtro
        + ' ORDER BY (' + d.clave + '::text = $2) ASC LIMIT 1', [ex, propioDe]);
    if (rows.length) out.push({ familia: d.familia, clave: String(rows[0].clave), que: d.que });
  }
  return out;
}

/**
 * ¿Quién ocupa `exten` en `internal`? Devuelve `null` si está libre o si lo que hay es de
 * quien pregunta (que lo va a reescribir), y `{familia, que, mensaje}` si lo tiene otro.
 *
 * @param c       cliente de la transacción en curso (el BEGIN ya está hecho)
 * @param exten   extensión tal cual va al dialplan (con `_` si es patrón)
 * @param familia familia de quien pregunta (clave de DUENOS)
 * @param propio  identificador de la fila propia que se está editando: el `id`, o la
 *                `accion` para los códigos de función. `null` en un alta.
 */
async function duenoDeInternal(c, exten, familia, propio) {
  const ex = sinGuion(exten);
  if (!ex) return null;
  let mio = false;
  for (const r of await reclamos(c, exten, familia, propio)) {
    /* Es la fila que estoy editando: la extensión publicada es la mía y la voy a
     * reescribir. Se SIGUE preguntando (`continue`, no `return`) porque los chequeos que
     * vienen después —interno, resto del plan de marcado— son independientes de éste:
     * cortar acá dejaba que una DISA se mudara encima de un interno con sólo estar
     * editando una fila propia. */
    if (r.familia === familia && propio != null && r.clave === String(propio)) { mio = true; continue; }
    return { familia: r.familia, que: r.que, mensaje: 'ese número ya lo usa ' + r.que };
  }
  /* Un interno. Sin `.catch(() => ({rows:[]}))`: esto corre DENTRO de una transacción y en
   * Postgres cualquier error deja la transacción abortada, así que tragárselo no era
   * «seguir adelante» sino que todo lo que viene después falle con un error peor y sin
   * relación con la causa. Si `ps_endpoints` no contesta, el alta se rechaza y se ve por qué. */
  const { rows: ep } = await c.query('SELECT 1 FROM ps_endpoints WHERE id=$1 LIMIT 1', [ex]);
  if (ep.length) return { familia: 'extension', que: 'un interno', mensaje: 'ese número es el de un interno' };
  /* Y el resto de lo que vive en `internal` y no tiene tabla en esta lista (rutas
   * salientes, salas, lo que agregue mañana otro módulo): si hay dialplan publicado,
   * no lo reclama mi tabla y no lleva mi firma, no se toca. Acá la extensión va en CRUDO:
   * en `extensions` el patrón se guarda con `_`. */
  const { rows: pub } = await c.query("SELECT app, appdata FROM extensions WHERE context='internal' AND exten=$1 AND priority=1", [exten]);
  if (pub.length && !mio && !pub.some((f) => esFilaPropia(familia, f))) {
    return { familia: 'dialplan', que: 'una ruta saliente u otra aplicación', mensaje: 'ese número ya está ocupado en el plan de marcado (una ruta saliente u otra aplicación)' };
  }
  return null;
}

/* Igual que la anterior pero corta con 409 diciendo QUIÉN lo ocupa: el administrador tiene
 * que poder arreglarlo sin ir a mirar la base. Se comprueba aunque la aplicación se cree
 * APAGADA, porque el alta le borra el dialplan al otro igual. */
async function exigirLibre(c, exten, familia, propio) {
  const d = await duenoDeInternal(c, exten, familia, propio);
  if (d) throw err409(d.mensaje);
}

/* Borra del dialplan SÓLO si esa extensión la publicó `familia`. Sin esa certeza no se
 * toca nada: es preferible dejar una extensión vieja colgada —que se ve con `dialplan
 * show` y la saca el administrador— antes que borrarle el dialplan a otra aplicación.
 * Propia es la que lleva la firma de la familia o la que reclama su propia tabla con esa
 * clave (`propio`), que es lo único que hay para los cuatro códigos de función heredados
 * de apps.js, sin `NoOp` de cabecera. */
async function borrarPropio(c, exten, familia, propio, log) {
  if (!exten) return;
  const { rows } = await c.query("SELECT app, appdata FROM extensions WHERE context='internal' AND exten=$1 AND priority=1", [exten]);
  if (!rows.length) return;
  const quienes = await reclamos(c, exten, familia, propio);
  const ajeno = quienes.some((r) => r.familia !== familia);
  const mio = rows.some((f) => esFilaPropia(familia, f))
    || (propio != null && quienes.some((r) => r.familia === familia && r.clave === String(propio)));
  if (ajeno || !mio) {
    if (log && log.error) log.error('no borro ' + exten + ' de internal: el dialplan que hay ahí no lo publicó ' + familia);
    return;
  }
  await c.query("DELETE FROM extensions WHERE context='internal' AND exten=$1", [exten]);
}

module.exports = { DUENOS, MARCA, sinGuion, esFilaPropia, reclamos, duenoDeInternal, exigirLibre, borrarPropio };
