-- Grabacion de agentes de IA e IVR, y clasificacion de origen de cada grabacion.
--
-- Por que una columna `origen` y no deducirlo del nombre en cada consulta: el nombre del
-- archivo es un dato de Asterisk y ya cambio de forma una vez (las colas escribian
-- `pbxng-q<nombre con espacios>-<uniqueid>.wav`, que el indexador no aceptaba). El origen
-- se decide UNA vez, al indexar, y el panel filtra por columna.
ALTER TABLE pbxng_recordings ADD COLUMN IF NOT EXISTS origen text;
UPDATE pbxng_recordings SET origen = 'interno' WHERE origen IS NULL;
CREATE INDEX IF NOT EXISTS pbxng_recordings_origen_idx ON pbxng_recordings (origen);

-- Grabar o no es por objeto, no global: un agente de IA que atiende ventas se graba y el
-- que solo informa un horario no tiene por que.
ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS record boolean NOT NULL DEFAULT false;
ALTER TABLE pbxng_ivr      ADD COLUMN IF NOT EXISTS record boolean NOT NULL DEFAULT false;
