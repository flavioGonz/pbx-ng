-- PBX-NG · 0027 · El historial de las reuniones: quién entró, cuándo y por cuánto.
--
-- QUÉ FALTABA. La sala sabía decir quién está adentro AHORA y nada más. Terminada la
-- reunión no quedaba rastro: ni quiénes participaron, ni cuánto duró, ni si alguien entró
-- media hora tarde. Para una sala de directorio —o para facturar una reunión con un
-- cliente— eso es justamente lo que se pregunta al día siguiente.
--
-- DOS TABLAS Y NO UNA, porque son dos preguntas distintas: «qué reuniones hubo» y «quién
-- estuvo en cada una». Con una sola fila por participante habría que adivinar dónde
-- empieza y termina cada reunión agrupando por tiempo, que es exactamente el tipo de
-- cuenta que sale mal el día que dos reuniones se tocan.
--
-- `fin_estimado` es honestidad: si la central se reinicia con la reunión abierta, el
-- evento de cierre nunca llega. Se cierra la fila igual —dejarla abierta para siempre es
-- peor— pero marcada, y el panel lo dice en vez de mostrar una duración inventada.
CREATE TABLE IF NOT EXISTS pbxng_conf_reuniones (
  id            bigserial PRIMARY KEY,
  sala          text NOT NULL,
  inicio        timestamptz NOT NULL DEFAULT now(),
  fin           timestamptz,
  fin_estimado  boolean NOT NULL DEFAULT false,
  pico          integer NOT NULL DEFAULT 0,          -- cuántos llegaron a estar a la vez
  grabada       boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS pbxng_conf_reuniones_sala ON pbxng_conf_reuniones (sala, inicio DESC);
CREATE INDEX IF NOT EXISTS pbxng_conf_reuniones_abiertas ON pbxng_conf_reuniones (sala) WHERE fin IS NULL;

CREATE TABLE IF NOT EXISTS pbxng_conf_presencias (
  id            bigserial PRIMARY KEY,
  reunion_id    bigint REFERENCES pbxng_conf_reuniones(id) ON DELETE CASCADE,
  sala          text NOT NULL,
  canal         text NOT NULL,
  quien         text,                                 -- CallerIDName: el nombre que dio el invitado web o el del interno
  numero        text,                                 -- CallerIDNum: el interno, o el id de la sesión web
  moderador     boolean NOT NULL DEFAULT false,
  web           boolean NOT NULL DEFAULT false,       -- entró por el enlace (endpoint descartable c2c*)
  entro         timestamptz NOT NULL DEFAULT now(),
  salio         timestamptz,
  fin_estimado  boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS pbxng_conf_presencias_reunion ON pbxng_conf_presencias (reunion_id);
CREATE INDEX IF NOT EXISTS pbxng_conf_presencias_abiertas ON pbxng_conf_presencias (canal) WHERE salio IS NULL;
