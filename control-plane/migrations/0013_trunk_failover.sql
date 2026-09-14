-- 0013 · Failover de troncal (ítem 10 de docs/BRECHA-UCM-XORCOM.md): una ruta saliente
-- deja de tener UNA troncal y pasa a tener una principal más una lista ORDENADA de
-- respaldos. Lo sirve control-plane/trunks.js.
--
-- Por qué `backups` es un jsonb y no una tabla aparte: el orden ES el dato (primero el
-- respaldo bueno, después el caro), y una tabla con columna `pos` obliga a reordenar N
-- filas en cada arrastre del panel para no ganar nada: la lista se lee y se escribe
-- siempre entera, junto con la ruta, dentro de la misma transacción que reescribe el
-- dialplan. Vacío (el default) = la ruta se comporta exactamente como hasta 1.9.0.
--
-- Idempotente: todo con IF NOT EXISTS / ON CONFLICT.

ALTER TABLE pbxng_outbound_routes ADD COLUMN IF NOT EXISTS backups jsonb NOT NULL DEFAULT '[]';

-- Cuánto se espera en CADA intento y cuánto en TOTAL. Con tres troncales y los 60 s de
-- siempre por intento, el que llama se comía 180 s de silencio antes de la congestión;
-- por eso el intento baja a 20 s y hay además un tope total que se chequea antes de
-- cada Dial (el dialplan lo mira con ${EPOCH}, así que un intento largo no lo evade).
ALTER TABLE pbxng_outbound_routes ADD COLUMN IF NOT EXISTS intento_seg int NOT NULL DEFAULT 20;
ALTER TABLE pbxng_outbound_routes ADD COLUMN IF NOT EXISTS total_seg   int NOT NULL DEFAULT 45;

-- Aviso de failover. Apagado como el resto del catálogo: el admin decide qué recibir.
-- throttle chico (5 min) porque el motor ya avisa UNA vez por transición, no por llamada:
-- el throttle es sólo la red por si una troncal queda oscilando.
INSERT INTO pbxng_alert_rules (event, enabled, params, throttle_min) VALUES
  ('trunk.failover', false, '{}', 5)
ON CONFLICT (event) DO NOTHING;
