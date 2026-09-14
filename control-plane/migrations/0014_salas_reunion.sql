-- 0014 · Salas de reunión (ítem 9 de docs/BRECHA-UCM-XORCOM.md): la conferencia deja de
-- ser «un ConfBridge con un PIN opcional» y pasa a ser un objeto administrable con dos
-- PIN (participante y moderador), tope de participantes, música en espera hasta que entre
-- el moderador, anuncio de entrada/salida, grabación y una reunión agendada. Lo sirve
-- control-plane/salas.js.
--
-- Se AMPLÍA pbxng_conferences en vez de crear una tabla nueva: las salas que ya existen
-- (y su número de acceso, que puede estar impreso en una tarjeta) tienen que seguir
-- funcionando; TODAS las columnas nuevas nacen con el comportamiento de antes, los PIN
-- incluidos: esta migración no le cambia la política de acceso a ninguna sala existente
-- (ver el bloque del final).
--
-- Por qué la agenda es una sola reunión y no una tabla de reservas: lo que el cliente
-- pide en la demo es «esta sala se abre el martes a las 10 y dura una hora». Una grilla
-- de reservas recurrentes es otro producto (y otra pantalla); cuando haga falta, esta
-- columna se convierte en la fila «próxima reunión» de esa tabla sin romper el dialplan,
-- porque el dialplan NO mira la agenda: mira DB(sala/<nombre>), que escribe la API.
--
-- Idempotente: todo con IF NOT EXISTS / ON CONFLICT.

-- PIN del moderador. El de participante ya existía (`pin`) y era opcional. En las salas
-- NUEVAS los dos son obligatorios y distintos, y los genera la API al azar si no vienen
-- (con el buzón de voz ya aprendimos que «PIN = número de interno» es no tener PIN). En
-- las que ya existen queda NULL: ver el bloque del final.
ALTER TABLE pbxng_conferences ADD COLUMN IF NOT EXISTS pin_mod text;

-- 0 = sin tope (el default de ConfBridge). Es el freno a que una sala de directorio se
-- llene de gente que marcó mal el número.
ALTER TABLE pbxng_conferences ADD COLUMN IF NOT EXISTS max_part int NOT NULL DEFAULT 0;

-- Música en espera hasta que entre el moderador: el que llega primero no escucha silencio
-- ni cree que la sala está rota.
ALTER TABLE pbxng_conferences ADD COLUMN IF NOT EXISTS moh_hasta_moderador boolean NOT NULL DEFAULT true;

-- Anuncio de entrada y salida (ConfBridge le pide el nombre al que entra y lo anuncia).
ALTER TABLE pbxng_conferences ADD COLUMN IF NOT EXISTS anunciar boolean NOT NULL DEFAULT true;

-- Grabación de la reunión. Apagada por defecto: grabar a escondidas a los participantes
-- de una reunión no es una opción razonable como valor de fábrica.
ALTER TABLE pbxng_conferences ADD COLUMN IF NOT EXISTS grabar boolean NOT NULL DEFAULT false;

-- Agenda: inicio y duración. NULL = sala siempre abierta (como hasta 1.9.x).
-- `timestamptz` y no fecha+hora sueltas para no volver a discutir el huso: la ventana se
-- calcula en Postgres con now() y el panel manda ISO.
ALTER TABLE pbxng_conferences ADD COLUMN IF NOT EXISTS agenda_inicio timestamptz;
ALTER TABLE pbxng_conferences ADD COLUMN IF NOT EXISTS agenda_min int;

-- Aviso que escucha el que llama fuera de la ventana agendada (prompt de Asterisk).
ALTER TABLE pbxng_conferences ADD COLUMN IF NOT EXISTS aviso_cerrada text NOT NULL DEFAULT 'conf-locked';

-- A quiénes se invitó por correo y cuándo (para que el panel muestre «ya se invitó» y no
-- se mande dos veces la misma invitación sin querer).
ALTER TABLE pbxng_conferences ADD COLUMN IF NOT EXISTS invitados jsonb NOT NULL DEFAULT '[]';
ALTER TABLE pbxng_conferences ADD COLUMN IF NOT EXISTS invitado_at timestamptz;

-- LAS SALAS QUE YA EXISTEN NO SE TOCAN (y por qué).
-- La versión anterior de esta migración le ponía un PIN al azar a toda sala que no tenía
-- (`UPDATE … SET pin = COALESCE(NULLIF(pin,''), …random…)`). Está mal por dos motivos:
--
--   1. El dialplan de esas salas NO lo reescribe una migración. En pbx01 hay conferencias
--      de verdad, con el dialplan viejo (Answer · Authenticate · ConfBridge · Hangup) o
--      sin PIN ninguno. Después del UPDATE la base decía un PIN que el dialplan no pedía:
--      el administrador veía en el panel un PIN que no rige, que es peor que no ver
--      ninguno — se lo dicta a un invitado por teléfono y la reunión no abre.
--   2. Una sala sin PIN es una decisión que alguien tomó (la sala de la recepción, la de
--      soporte). Una migración no es el lugar para cambiarle la política de acceso a una
--      central que está andando.
--
-- Qué pasa entonces con las salas viejas: se quedan como están (`pin` tal cual, `pin_mod`
-- en NULL) y el panel las marca con un badge rojo «Sin PIN» en el listado, con un aviso
-- arriba de la tabla que las nombra. `salas.js` republica su dialplan al arrancar para que
-- las funciones nuevas (tope, grabación, música hasta el moderador, anuncios, agenda) les
-- apliquen igual, y genera un plan SIN pedir PIN cuando la sala no tiene: el dialplan
-- vuelve a decir exactamente lo que dice la base. Ponerle PIN es entrar a editarla desde
-- el panel, que es donde se ve lo que se está cambiando.
--
-- Las salas NUEVAS sí nacen con los dos PIN al azar: eso lo hace la API (`salas.js`), que
-- es quien además escribe el dialplan en el mismo movimiento.
