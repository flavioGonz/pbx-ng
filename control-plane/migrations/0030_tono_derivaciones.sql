-- PBX-NG · 0030 · TONO EN LAS DERIVACIONES DE LA IA: ${DIAL_OPCIONES} en los Dial que
-- escribió el panel ANTES de este cambio.
--
-- POR QUÉ: cuando la IA deriva, ai-pipeline.js pone DIAL_OPCIONES=r en el canal (ya
-- atendido) y los Dial la pasan como opciones para que la central genere el tono de
-- llamada. apps.js ya escribe la variable en los grupos de timbre y en las opciones de IVR
-- que marcan un interno, pero solo al crearlos o guardarlos: los que ya estaban en la base
-- seguían con el Dial viejo, y una derivación a uno de ellos sonaba muda. Un grupo de
-- timbre ni siquiera tiene edición, así que sin esto habría que borrarlo y crearlo de nuevo.
--
-- QUÉ TOCA, y nada más: solo agrega el sufijo, y solo a las filas con la forma EXACTA que
-- escribía apps.js (la regex). Así es idempotente —una fila que ya lo tiene no calza— y
-- no pisa un Dial que alguien haya escrito a mano con otras opciones. Quedan afuera los
-- agentes de IA (Stasis), las salas (ConfBridge), las colas, las rutas entrantes
-- (from-trunk) y salientes (internal) aunque tengan un Dial parecido: el UPDATE va atado
-- al grupo o al IVR dueño de la extensión.
--
-- El `${DIAL_OPCIONES}` va literal: migrate.js manda el archivo sin parámetros, y dentro de
-- una cadena entre comillas simples Postgres no interpreta el `$`.

-- Grupos de timbre: apps.js escribe [1 NoOp, 2 Dial 'PJSIP/a&PJSIP/b,<timbre>', 3 Hangup]
-- en el contexto ivr, con la extensión de acceso del grupo. El tope de largo es el de la
-- columna (varchar 256): un grupo enorme se deja como está antes que cortar la migración,
-- y el aviso de abajo lo nombra.
UPDATE extensions e
   SET appdata = e.appdata || ',${DIAL_OPCIONES}'
  FROM pbxng_ringgroups g
 WHERE e.context = 'ivr' AND e.exten = g.access_exten
   AND e.priority = 2 AND e.app = 'Dial'
   AND e.appdata ~ '^PJSIP/[^,]+,[0-9]+$'
   AND length(e.appdata) + length(',${DIAL_OPCIONES}') <= 256;

-- Opciones de IVR que marcan un interno: buildIvrDialplan escribe 'PJSIP/<interno>,30' en
-- la prioridad 100 + 10·i + 1 del contexto ivr, con la extensión del IVR.
UPDATE extensions e
   SET appdata = e.appdata || ',${DIAL_OPCIONES}'
  FROM pbxng_ivr i
 WHERE e.context = 'ivr' AND e.exten = i.exten
   AND e.app = 'Dial' AND e.priority >= 100
   AND e.appdata ~ '^PJSIP/[0-9]+,30$';

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT g.name, e.exten FROM extensions e JOIN pbxng_ringgroups g ON e.context = 'ivr' AND e.exten = g.access_exten
            WHERE e.priority = 2 AND e.app = 'Dial' AND e.appdata ~ '^PJSIP/[^,]+,[0-9]+$' LOOP
    RAISE NOTICE 'grupo de timbre % (%): el Dial es demasiado largo para agregarle ${DIAL_OPCIONES}; una derivación de la IA a este grupo puede sonar muda', r.name, r.exten;
  END LOOP;
END $$;
