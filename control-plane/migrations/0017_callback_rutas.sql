-- PBX-NG · Sprint 7 (0017) · Rutas salientes habilitadas por callback.
-- Lo consume control-plane/marcacion.js.
--
-- POR QUÉ: el callback devuelve la llamada al CallerID de quien llamó, y el CallerID se
-- falsea con dos líneas de configuración en cualquier softphone. En modo `lista` eso lo
-- frena la lista blanca (el número tiene que estar sí o sí en `numeros`), pero en modo
-- `pin` no había NADA: quien supiera —o adivinara— el PIN llamaba anunciándose como un
-- número premium internacional y la central lo llamaba. Los únicos frenos eran el
-- `cooldown_seg` y el `max_dia`, o sea veinte llamadas internacionales por día, todos los
-- días. `rutas` es la misma lista de ids de `pbxng_outbound_routes` que ya tiene
-- `pbxng_disa`: el número al que se devuelve la llamada tiene que caer en una de ellas.
--
-- Arranca en '[]' a propósito, y así los callbacks que ya existen NO cambian de
-- comportamiento: con `rutas` vacía sigue mandando la lista blanca, que es lo que los
-- protegía. Lo que sí deja de poder hacerse (lo valida la API, no esta migración) es
-- ENCENDER un callback en modo `pin` sin ninguna ruta habilitada.
ALTER TABLE pbxng_callback ADD COLUMN IF NOT EXISTS rutas jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Un callback en modo `pin` ya encendido de antes queda apagado: no hay forma de saber a
-- qué rutas quería restringirlo el administrador, y dejarlo prendido sin restricción es
-- justamente el agujero que cierra esta migración. Se vuelve a encender desde el panel
-- después de elegir las rutas.
UPDATE pbxng_callback SET enabled = false WHERE enabled AND modo = 'pin';
-- Y se le saca la extensión del plan de marcado, porque apagarlo sólo en la tabla deja el
-- número atendiendo (y contestando, que es tarifar) para después no hacer nada.
DELETE FROM extensions WHERE context = 'internal'
  AND exten IN (SELECT exten FROM pbxng_callback WHERE modo = 'pin' AND NOT enabled);
