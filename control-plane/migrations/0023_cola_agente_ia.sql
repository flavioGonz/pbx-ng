-- PBX-NG · 0023 · Un agente de IA puede atender una COLA.
--
-- POR QUÉ: hasta acá un agente de IA sólo se podía marcar directo (un interno con
-- `Stasis(pbxng,ai,<id>)`). Servía para un IVR conversacional y no para lo que se quiere
-- hacer: que el centro de monitoreo deje de tener personas atendiendo cada portero. Para
-- eso el agente tiene que ser UN MIEMBRO MÁS de la cola, con las mismas reglas que un
-- humano —estrategia, timbrado, pausa— y no un destino al que la cola rebota.
--
-- LAS TRES COLUMNAS QUE IMPORTAN, Y POR QUÉ CADA UNA:
--
--   `ia_modo`         apagado | primero | desborde.
--                     `desborde` es el modo con el que se despliega la primera vez: los
--                     humanos siguen atendiendo y la IA toma lo que se caería. Se
--                     implementa con la PENALIDAD de la cola (los humanos en 0, la IA en
--                     1), que es el mecanismo que Asterisk ya tiene para esto: sólo se
--                     timbra a la penalidad 1 cuando ningún miembro de la 0 puede atender.
--
--   `ia_simultaneas`  cuántas llamadas puede tomar a la vez. NO es un capricho de
--                     capacidad: una sesión de modelo realtime se paga por minuto, así que
--                     esto es, sobre todo, un tope de GASTO. Una ráfaga de timbres sin
--                     tope abre veinte sesiones al mismo tiempo.
--                     Asterisk cuenta un miembro como ocupado mientras está en una
--                     llamada, así que N simultáneas = N miembros, cada uno con su propia
--                     extensión Local (ver `iaMiembros()` en apps.js).
--
--   `ia_escalar_a`    a dónde va cuando el visitante pide una persona, cuando el agente
--                     duda, o cuando el modelo no contesta. Vacío = a los humanos de la
--                     misma cola. **Que exista siempre es la condición para prender esto
--                     en un cliente real.**
--
-- NADA se enciende solo: `ia_modo` nace en 'apagado' en todas las colas que ya existen.
-- Una actualización no pone a un robot a atender el portero de nadie.
ALTER TABLE pbxng_queues ADD COLUMN IF NOT EXISTS ia_agente_id    int;
ALTER TABLE pbxng_queues ADD COLUMN IF NOT EXISTS ia_modo         text NOT NULL DEFAULT 'apagado';
ALTER TABLE pbxng_queues ADD COLUMN IF NOT EXISTS ia_simultaneas  int  NOT NULL DEFAULT 1;
ALTER TABLE pbxng_queues ADD COLUMN IF NOT EXISTS ia_escalar_a    text;

-- El agente puede borrarse desde /voz; la cola no puede quedar apuntando a un id que ya no
-- existe (se vería como «IA encendida» con un miembro que nunca timbra).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pbxng_queues_ia_agente_fk') THEN
    ALTER TABLE pbxng_queues
      ADD CONSTRAINT pbxng_queues_ia_agente_fk
      FOREIGN KEY (ia_agente_id) REFERENCES pbxng_ai_agents(id) ON DELETE SET NULL;
  END IF;
END $$;
