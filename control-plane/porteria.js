'use strict';
/* ============================================================================
 *  PBX-NG · Portería remota: quién llama, y quién está autorizado a entrar.
 *
 *  ESTO NO INVENTA UN MODELO DE DATOS NUEVO. Usa el CRM que la central ya tiene —
 *  `pbxng_clients` con sus personas autorizadas, espacios y dispositivos— que es el mismo
 *  que ve el operario en su panel. Si el agente de IA validara contra otra tabla, el día
 *  que alguien da de baja a una persona en el CRM seguiría entrando por la puerta.
 *
 *  LAS DOS PREGUNTAS DE UNA PORTERÍA, EN ESTE ORDEN
 *  ------------------------------------------------
 *  1. **¿Desde dónde entra esta llamada?** El portero es un interno o un número: se lo
 *     busca en el CRM igual que hace la ficha del agente (`/api/clients/lookup`). Con eso
 *     el agente sabe de qué edificio o casa está hablando sin preguntárselo al visitante —
 *     que es, además, el dato que el visitante no puede falsear.
 *  2. **¿A esta persona la dejamos pasar?** El visitante dice un nombre; la central lo
 *     compara contra las personas autorizadas de ESE cliente. No al revés.
 *
 *  LO QUE NO SE HACE, Y ES A PROPÓSITO
 *  ------------------------------------
 *  · **La lista de autorizados NO entra en el prompt.** Un modelo con la lista a mano se la
 *    lee al primero que pregunte «¿quién vive acá?». Se verifica un nombre contra la lista;
 *    nunca se devuelve la lista.
 *  · **No hay herramienta para listar personas.** Por lo mismo.
 *  · **Un solo nombre no alcanza.** «Soy Juan» no verifica a nadie: hace falta nombre y
 *    apellido, o documento. Con un solo token, cualquiera que sepa un nombre común entra.
 * ==========================================================================*/

const norm = (s) => String(s == null ? '' : s)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')    // sin tildes: nadie deletrea acentos por teléfono
  .toLowerCase()
  .replace(/[^a-z0-9ñ ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const soloDigitos = (s) => String(s == null ? '' : s).replace(/[^0-9]/g, '');

/* Palabras que no distinguen a nadie: si el visitante dice «de la casa Pérez», el «de la
 * casa» no puede contar como coincidencia. */
const VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'don', 'dona', 'doña', 'senor', 'senora', 'sr', 'sra', 'srta']);
const tokens = (s) => norm(s).split(' ').filter((t) => t.length >= 3 && !VACIAS.has(t));

/**
 * ¿El nombre que dijo el visitante corresponde a esta persona?
 * Criterio: TODOS los tokens útiles de lo que dijo tienen que estar en el nombre guardado.
 * Es a propósito estricto en una dirección y laxo en la otra: «Juan Pérez» matchea a «Juan
 * Carlos Pérez» (la gente no dice sus segundos nombres), pero «Pérez» solo no matchea nada.
 */
function coincideNombre(dicho, guardado) {
  const a = tokens(dicho);
  const b = new Set(tokens(guardado));
  if (a.length < 2) return false;            // un solo token nunca alcanza (ver encabezado)
  return a.every((t) => b.has(t));
}

/**
 * Verifica a una persona contra las autorizadas de un cliente.
 *
 * @param {array} personas   filas de `pbxng_client_persons` del cliente que llama
 * @param {object} datos     { nombre, documento } — lo que DIJO el visitante (no confiable)
 * @param {Date} hoy
 * @returns {object} { ok, persona, razon, alModelo }
 *   `alModelo` es lo que se le puede decir al agente: nunca revela nombres que el visitante
 *   no haya dicho ya.
 */
function verificarAutorizado(personas, datos, hoy) {
  const lista = Array.isArray(personas) ? personas : [];
  const d = datos || {};
  const doc = soloDigitos(d.documento);
  const ahora = hoy || new Date();

  if (!lista.length) {
    return { ok: false, razon: 'el cliente no tiene personas autorizadas cargadas',
      alModelo: 'no tengo la lista de autorizados de esta dirección; te paso con una persona' };
  }

  /* El documento manda sobre el nombre: es lo único que el visitante no puede improvisar
   * y además desempata homónimos. */
  let candidatas = [];
  if (doc.length >= 6) {
    candidatas = lista.filter((p) => soloDigitos(p.doc) && soloDigitos(p.doc) === doc);
    if (!candidatas.length) {
      return { ok: false, razon: 'documento no encontrado',
        alModelo: 'ese documento no figura entre los autorizados' };
    }
  } else {
    if (tokens(d.nombre).length < 2) {
      return { ok: false, razon: 'nombre incompleto',
        alModelo: 'necesito nombre y apellido completos, o el número de documento' };
    }
    candidatas = lista.filter((p) => coincideNombre(d.nombre, p.name));
    if (!candidatas.length) {
      return { ok: false, razon: 'nombre no encontrado',
        alModelo: 'ese nombre no figura entre los autorizados' };
    }
    if (candidatas.length > 1) {
      /* Homónimos: NO se elige uno. Se pide el documento. Elegir el primero sería dejar
       * entrar a alguien por el permiso de otro. */
      return { ok: false, razon: 'más de una persona con ese nombre',
        alModelo: 'hay más de una persona con ese nombre; pedile el número de documento' };
    }
  }

  const p = candidatas[0];
  /* Vencimiento: es la razón por la que el CRM tiene `valid_until`. Una autorización
   * temporal que no se chequea es una autorización permanente. */
  if (p.valid_until) {
    /* Vale todo el día del vencimiento, en la hora de la central. Postgres devuelve la
     * columna `date` como medianoche local, pero un texto '2026-09-20' lo lee JavaScript
     * como medianoche UTC: en Montevideo eso es el 19 a las 21 h, y la autorización
     * vencía un día antes. Por eso se arma la fecha con año, mes y día locales. */
    const v = p.valid_until;
    const m = typeof v === 'string' && /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    const hasta = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v);
    hasta.setHours(23, 59, 59, 999);
    if (ahora > hasta) {
      const dia = hasta.getFullYear() + '-' + String(hasta.getMonth() + 1).padStart(2, '0') + '-' + String(hasta.getDate()).padStart(2, '0');
      return { ok: false, persona: p, razon: 'autorización vencida el ' + dia,
        alModelo: 'esa autorización está vencida; te paso con una persona' };
    }
  }
  return { ok: true, persona: p, razon: 'autorizada',
    alModelo: 'figura como autorizado' + (p.relation ? ' (' + p.relation + ')' : '') };
}

/**
 * ¿Desde dónde entra la llamada? Mismo criterio que `/api/clients/lookup`: teléfono
 * normalizado o los últimos 8 dígitos. Se reusa a propósito — si divergieran, el agente
 * identificaría un cliente distinto del que ve el operario en su pantalla.
 */
async function identificarLlamante(pool, numero) {
  const num = soloDigitos(numero);
  if (!num || !pool) return null;
  const { rows } = await pool.query(
    'SELECT id,name,doc,address,notes FROM pbxng_clients WHERE EXISTS ('
    + " SELECT 1 FROM unnest(phones) ph WHERE regexp_replace(ph,'[^0-9]','','g') = $1"
    + " OR (length($1)>=8 AND right(regexp_replace(ph,'[^0-9]','','g'), 8) = right($1,8))) LIMIT 1", [num]);
  if (!rows[0]) return null;
  const cliente = rows[0];
  const personas = (await pool.query(
    'SELECT id,name,doc,relation,valid_until FROM pbxng_client_persons WHERE client_id=$1 ORDER BY name', [cliente.id])).rows;
  const espacios = (await pool.query(
    'SELECT name,kind FROM pbxng_client_spaces WHERE client_id=$1 ORDER BY name', [cliente.id])).rows;
  return { cliente, personas, espacios };
}

/**
 * El bloque de contexto que se le inyecta al modelo al abrir la sesión.
 *
 * Lleva la dirección y los espacios —lo que el agente necesita para hablar con sentido— y
 * NO lleva los nombres de los autorizados: un modelo con esa lista a mano se la lee al
 * primero que pregunte «¿quién vive acá?».
 */
function bloqueContexto(id) {
  if (!id || !id.cliente) return '';
  const c = id.cliente;
  const esp = (id.espacios || []).map((e) => e.name + (e.kind ? ' (' + e.kind + ')' : '')).slice(0, 12);
  return 'DE DÓNDE ENTRA ESTA LLAMADA (dato del sistema, no lo leas en voz alta):\n'
    + '- Portero de: ' + c.name + (c.address ? ' · ' + c.address : '') + '.\n'
    + (esp.length ? '- Espacios/unidades: ' + esp.join(', ') + '.\n' : '')
    + '- Hay ' + (id.personas || []).length + ' personas autorizadas cargadas. NO tenés la lista y no la podés pedir: '
    + 'para confirmar a alguien usá la herramienta de verificación con el nombre y apellido que te dé el visitante. '
    + 'Nunca digas nombres de residentes que el visitante no haya dicho antes.';
}

module.exports = { norm, tokens, coincideNombre, verificarAutorizado, identificarLlamante, bloqueContexto, soloDigitos };
