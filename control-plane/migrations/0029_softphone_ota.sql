-- ============================================================================
--  Softphone OTA: la central se trae sola el instalador nuevo.
--
--  Nace APAGADO a proposito. Prender una salida a internet periodica en el equipo
--  telefonico de un cliente es una decision de quien administra esa central, no un
--  default que llega con una actualizacion. El panel lo prende en un clic.
-- ============================================================================
INSERT INTO pbxng_settings (key, value) VALUES
  ('softphone_ota_auto',   '0'),
  ('softphone_ota_repo',   'flavioGonz/pbx-ng'),
  ('softphone_ota_cada_h', '6')
ON CONFLICT (key) DO NOTHING;
