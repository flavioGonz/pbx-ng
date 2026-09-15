'use strict';
/* PBX-NG · El PIN del buzón de voz: generación, validación y alta del buzón.
 *
 * POR QUÉ ESTE ARCHIVO EXISTE: el buzón se creaba en CUATRO lugares (los tres
 * `createWebrtcEndpoint` / `createSipEndpoint` / alta manual de endpoint de app.js y el
 * `POST /api/mailboxes` de apps.js) y los cuatro escribían el MISMO INSERT con
 * `password = mailbox`. O sea que el PIN del buzón del interno 1001 era «1001»: no había
 * PIN. Cualquiera con un teléfono registrado marcaba `*98`, ponía 1001 y 1001, y escuchaba
 * los mensajes de otro —el mismo agujero que las salas de reunión tenían hasta 1.10.0—.
 * Con cuatro copias del INSERT, arreglarlo en tres y olvidarse de una era cuestión de
 * tiempo; acá hay UNA sola forma de crear un buzón y nace con PIN al azar.
 *
 * No es un módulo `init(deps)`: no registra rutas ni tiene estado, son funciones puras
 * (más `seed`, que recibe el cliente de Postgres). Mismo criterio que `dueno-internal.js`.
 */

const crypto = require('crypto');

/* El contexto de los buzones vive ACÁ y no en cada módulo. `apps.js` ya lo leía de
 * `VM_CONTEXT`, pero `seed()` tenía 'default' escrito a mano y `app.js`/`telefonia.js`
 * escribían '@default' en el dialplan y en `ps_endpoints.mailboxes`: con `VM_CONTEXT`
 * distinto de 'default', los buzones que creaba el alta de internos quedaban en OTRO
 * contexto que los que lista y rota el panel, y `VoiceMailMain` buscaba en un tercero.
 * Un valor compartido es el único que no se puede desincronizar. */
const VM_CTX = process.env.VM_CONTEXT || 'default';

/* Lo que se acepta como PIN escrito a mano en el panel. Asterisk compara el `password` de
 * la tabla `voicemail` con lo que el usuario MARCA, así que sólo dígitos: una letra ahí
 * es un buzón al que no se entra desde ningún teléfono. */
const PIN_OK = /^[0-9]{4,10}$/;

/* Seis dígitos con `crypto`: `Math.random` no sirve para un secreto (es predecible a
 * partir de un par de salidas). Se permiten ceros a la izquierda porque el usuario los
 * marca igual, y por eso se arma como texto y no como número. */
const pinNuevo = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

/* Un buzón cuyo PIN es el número del buzón es un buzón SIN PIN. Se calcula y no se guarda
 * en ninguna columna nueva a propósito: es una propiedad del dato que ya está, y una
 * columna «pin_debil» se desincroniza el día que alguien cambie el PIN por SQL o desde
 * `VoiceMailMain` (el propio Asterisk deja cambiarlo desde el teléfono y escribe la tabla
 * él mismo, sin pasar por esta API). Un PIN vacío cuenta como débil por lo mismo. */
const pinDebil = (mailbox, password) => {
  const p = String(password == null ? '' : password).trim();
  return p === '' || p === String(mailbox);
};

/* Alta del buzón de un interno recién creado. `ON CONFLICT`/`WHERE NOT EXISTS`: si el
 * buzón ya existía NO se le toca el PIN —el interno se puede recrear (un teléfono que se
 * reaprovisiona) y rotarle el PIN al dueño sin avisarle lo deja afuera de sus mensajes—.
 *
 * DEVUELVE el PIN cuando el buzón lo creó ESTA llamada (`{pin, creado:true}`), y
 * `{pin:null, creado:false}` cuando ya existía. Antes no devolvía nada y el PIN al azar
 * quedaba perdido: `POST /api/endpoints` respondía `{created, webrtc, video}`, el buzón
 * recién nacido todavía no tiene dirección de correo configurada (el aviso por correo no
 * tiene a dónde ir) y el usuario no podía entrar a su propio buzón. El PIN del buzón que
 * ya existía NO se devuelve: no lo generamos nosotros y el que lo necesite lo pide por
 * `GET /api/mailboxes/:mailbox`, que es la única lectura en claro y es admin. */
async function seed(c, mailbox, contexto = VM_CTX) {
  const pin = pinNuevo();
  const { rowCount } = await c.query(
    `INSERT INTO voicemail (context, mailbox, password, fullname)
     SELECT $2::text, $1::text, $3::text, 'Interno ' || $1::text
      WHERE NOT EXISTS (SELECT 1 FROM voicemail v WHERE v.mailbox = $1::text AND v.context = $2::text)`,
    [String(mailbox), contexto, pin]);
  return rowCount ? { pin, creado: true } : { pin: null, creado: false };
}

module.exports = { PIN_OK, VM_CTX, pinNuevo, pinDebil, seed };
