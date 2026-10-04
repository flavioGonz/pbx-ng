-- ============================================================================
--  El portero como aparato que se llama y que abre, no solo como una imagen.
--
--  Hasta ahora un dispositivo del CRM era una camara: etiqueta, tipo y RTSP. Un portero
--  es ademas un INTERNO al que se llama y uno o mas RELES que se abren, y eso no tenia
--  donde guardarse: el que atendia veia la puerta y despues tenia que irse a otra pantalla
--  a marcar el interno de memoria, y para abrir dependia de acordarse del codigo.
--
--  `rele_cfg` es jsonb y no columnas porque los tres modos no se parecen en nada:
--    dtmf    { reles: [{ nombre, codigo }] }               se manda EN la llamada
--    http    { marca, host, user, pass, reles: [{ nombre, num }] }   se le pega al aparato
--    codigo  { reles: [{ nombre, codigo }] }               lo marca la central
--  Meter los tres en columnas deja dos tercios en NULL siempre y una tabla que miente
--  sobre su propia forma.
-- ============================================================================
ALTER TABLE pbxng_client_devices
  ADD COLUMN IF NOT EXISTS ext       text,
  ADD COLUMN IF NOT EXISTS rele_modo text,
  ADD COLUMN IF NOT EXISTS rele_cfg  jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Un portero por interno: dos filas con el mismo numero serian dos aparatos distintos
-- peleandose por la misma llamada, y nadie sabria cual abrio.
CREATE UNIQUE INDEX IF NOT EXISTS pbxng_client_devices_ext_uniq
  ON pbxng_client_devices (ext) WHERE ext IS NOT NULL AND ext <> '';
