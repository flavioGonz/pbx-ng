-- PBX-NG · 0025 · Las herramientas que un agente de IA puede PEDIR, y el registro de lo
-- que hizo con ellas.
--
-- EL PRINCIPIO: el modelo no ejecuta nada, pide. La central decide. Por eso la
-- configuración vive acá —del lado nuestro, por agente— y no en el texto del prompt:
-- lo que está apagado no existe, por más que el modelo lo nombre.
--
-- `herramientas` es JSONB y no seis columnas porque el catálogo va a crecer y cada
-- herramienta tiene ajustes distintos (una necesita un interno, otra una ventana horaria).
-- Las claves son los nombres del catálogo de `herramientas.js`; lo que no esté ahí, no se
-- declara. Ejemplo de lo que guarda el panel:
--
--   {"verificar_unidad":{"on":true},
--    "transferir_a_agente":{"on":true},
--    "abrir_porton":{"on":true,"modo":"dtmf","dtmf":"#",
--                    "ventana":"07:00-22:00","max_por_hora":3,"exigir_verificacion":true}}
--
-- VACÍO por defecto: un agente que ya existe no gana herramientas en una actualización.
ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS herramientas jsonb NOT NULL DEFAULT '{}'::jsonb;

-- El registro de acciones. No es un log: es la respuesta a «¿quién abrió el portón a las
-- 3 de la mañana?», y por eso queda en la base y no en la salida del contenedor, que se
-- rota y se pierde. Se escribe SIEMPRE: las aperturas rechazadas también, porque una
-- ráfaga de rechazos es exactamente lo que hay que poder ver después.
CREATE TABLE IF NOT EXISTS pbxng_ia_acciones (
  id           bigserial PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  agente_id    int,
  sesion       text,
  llamante     text,
  herramienta  text NOT NULL,
  resultado    text,            -- ABIERTO | rechazada | transferida | mensaje guardado | error …
  razon        text,            -- por qué se rechazó
  motivo       text,            -- lo que dijo el modelo: a quién y por qué
  args         jsonb
);
-- El índice es por fecha porque la consulta real es «las últimas N» o «las de anoche».
CREATE INDEX IF NOT EXISTS pbxng_ia_acciones_ts ON pbxng_ia_acciones (ts DESC);
CREATE INDEX IF NOT EXISTS pbxng_ia_acciones_herr ON pbxng_ia_acciones (herramienta, ts DESC);
