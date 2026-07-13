-- Colas completas: metadatos propios (los campos nativos ya viven en la tabla realtime `queues`).
ALTER TABLE pbxng_queues ADD COLUMN IF NOT EXISTS max_wait      integer NOT NULL DEFAULT 0;      -- seg; 0 = sin limite
ALTER TABLE pbxng_queues ADD COLUMN IF NOT EXISTS timeout_dest  text    NOT NULL DEFAULT 'hangup'; -- hangup|ext|voicemail|queue|ivr
ALTER TABLE pbxng_queues ADD COLUMN IF NOT EXISTS timeout_value text;
ALTER TABLE pbxng_queues ADD COLUMN IF NOT EXISTS record        boolean NOT NULL DEFAULT false;  -- grabacion automatica de la cola
ALTER TABLE pbxng_queues ADD COLUMN IF NOT EXISTS welcome_text  text;    -- anuncio de bienvenida (texto -> TTS)
ALTER TABLE pbxng_queues ADD COLUMN IF NOT EXISTS welcome_ref   text;    -- prompt generado (custom/xxx)
ALTER TABLE pbxng_queues ADD COLUMN IF NOT EXISTS periodic_text text;    -- anuncio periodico (texto -> TTS)
ALTER TABLE pbxng_queues ADD COLUMN IF NOT EXISTS periodic_ref  text;
ALTER TABLE pbxng_queues ADD COLUMN IF NOT EXISTS voice         text;    -- voz TTS usada para los anuncios
