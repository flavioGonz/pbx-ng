-- PBX-NG · 0026 · La sala de reunión se puede abrir desde el navegador, y puede tener video.
--
-- QUÉ FALTABA. La sala era una conferencia de audio a la que sólo se entraba MARCANDO su
-- número desde un interno de la central. El correo de invitación mandaba el número y el
-- PIN: quien no era interno —un cliente, un proveedor, alguien con el celular— no tenía
-- puerta, y el enlace del correo llevaba al panel de administración, no a una sala.
--
-- `web_token` es esa puerta: un enlace público por sala, del mismo tipo que el de
-- click-to-call. El token ES la credencial, así que al invitado NO se le pide el PIN —se
-- entra por un enlace que se puede revocar, que es mejor que un número de cuatro dígitos
-- que no caduca—. Va con índice único parcial porque una sala puede no tener enlace: NULL
-- no es «token vacío», es «esta sala no se abre desde la web».
--
-- `video` enciende el modo SFU de ConfBridge para esa sala. Es por sala y no global porque
-- el video cuesta: una reunión de cuatro personas con cámara mueve varias veces el tráfico
-- de una de audio, y la mayoría de las salas de una central no lo necesitan.
ALTER TABLE pbxng_conferences ADD COLUMN IF NOT EXISTS video boolean NOT NULL DEFAULT false;
ALTER TABLE pbxng_conferences ADD COLUMN IF NOT EXISTS web_token text;
CREATE UNIQUE INDEX IF NOT EXISTS pbxng_conferences_web_token_uq
  ON pbxng_conferences (web_token) WHERE web_token IS NOT NULL;
