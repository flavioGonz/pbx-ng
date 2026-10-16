-- PBX-NG · 0032 · Candado por cuenta: el ataque que el contador por IP no puede ver.
--
-- POR QUÉ: los internos WebRTC entran por el proxy inverso, así que Asterisk reporta
-- SIEMPRE la IP del proxy. Medido en una central real:
--   SecurityEvent="InvalidAccountID" AccountID="999999" RemoteAddress="IPV4/WS/<proxy>/47920"
-- Esa IP además es privada, y guard.js exime a las privadas a propósito (un teléfono de
-- la LAN con la clave vieja no puede dejar a la oficina sin central). Resultado: una
-- fuerza bruta contra un interno WebRTC no se contaba, no se avisaba y no se baneaba. Y
-- banear al proxy sería peor: deja sin WebRTC a todos de una vez.
--
-- El `AccountID` del evento sí es real, aunque la IP no lo sea. Es lo único que queda
-- para ver ese ataque, y de paso agarra uno que el contador por IP nunca vio —con proxy
-- o sin él—: el distribuido, muchas IPs contra una sola cuenta.
--
-- QUÉ TOCA: una tabla nueva. Nada existente se modifica.
CREATE TABLE IF NOT EXISTS pbxng_cuenta_candado (
  ext         text PRIMARY KEY,
  -- NULL = hasta que alguien lo abra a mano (es lo que deja un candado puesto por el
  -- operador desde el panel; los automáticos siempre tienen vencimiento).
  hasta       timestamptz,
  motivo      text    NOT NULL DEFAULT '',
  fallos      int     NOT NULL DEFAULT 0,
  ips         text    NOT NULL DEFAULT '',
  -- A qué valor volver al abrir: el `auth` que tenía el endpoint antes. Se guarda acá y
  -- no se deduce del número, porque un endpoint puede apuntar a un auth con otro nombre.
  auth_previo text    NOT NULL DEFAULT '',
  manual      boolean NOT NULL DEFAULT false,
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pbxng_cuenta_candado_hasta ON pbxng_cuenta_candado (hasta);
