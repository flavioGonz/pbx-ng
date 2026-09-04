-- 0007 · Modulo "Conexion a SBC-NG".
--
-- SBC-NG es otro producto: PBX-NG funciona completo sin el. La conexion pasa a ser
-- un modulo (pbxng_settings.mod_sbc) APAGADO por defecto. Las instalaciones que ya
-- tenian la troncal fija al SBC (kind='sbc', normalmente 'to-sbc') lo arrancan
-- encendido para no cambiarles el ruteo. El modulo 'wsbridge' (servicio del SBC
-- embebido) deja de existir.
INSERT INTO pbxng_settings (key, value)
SELECT 'mod_sbc', '1'
 WHERE EXISTS (SELECT 1 FROM pbxng_trunks WHERE kind = 'sbc')
   AND NOT EXISTS (SELECT 1 FROM pbxng_settings WHERE key = 'mod_sbc')
ON CONFLICT (key) DO NOTHING;
DELETE FROM pbxng_settings WHERE key = 'mod_wsbridge';
