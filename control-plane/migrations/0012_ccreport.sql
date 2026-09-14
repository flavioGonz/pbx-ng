-- 0012 · Reportes de call center (ítem 8 de docs/BRECHA-UCM-XORCOM.md): el informe que
-- firma un supervisor. Lo sirve control-plane/ccreport.js.
--
-- POR QUÉ UNA TABLA NUEVA Y NO EL CDR: el CDR cuenta LLAMADAS (quién llamó a quién y
-- cuánto habló), no la vida de la llamada DENTRO de la cola. Nivel de servicio, abandono
-- y tiempo de espera necesitan saber cuándo entró a la cola, cuánto esperó, si colgó
-- antes de que la atendieran y qué agente la tomó — nada de eso está en `cdr`, y
-- deducirlo de `duration - billsec` mezcla el timbrado de una llamada directa con la
-- espera en cola. Asterisk sí lo sabe: lo publica por AMI (QueueCallerJoin,
-- QueueCallerAbandon, AgentConnect, AgentComplete, AgentRingNoAnswer) y lo escribe en su
-- `queue_log` de archivo, que en esta instalación no se persiste en Postgres.
--
-- Se elige el consumidor AMI (ccreport.js) en vez de activar el `queue_log` realtime de
-- Asterisk porque no hay que tocar ningún .conf de la imagen: la API ya está conectada al
-- AMI y ya consume eventos así (guard.js con los de seguridad, app.js con DialBegin).
-- Consecuencia honesta, y por eso el panel lo dice: los eventos se registran DESDE que se
-- instala esta versión; lo que pasó antes no se puede reconstruir.
--
-- Idempotente (IF NOT EXISTS / ON CONFLICT): se puede correr sobre una base que ya la tenga.

-- Vida de cada llamada dentro de una cola. Append-only; se poda por antigüedad
-- (`cc_retencion_dias`, 365 por defecto) igual que pbxng_sec_events.
--   evento: 'entra'         la llamada entró a la cola            (QueueCallerJoin)
--           'atendida'      un agente la tomó                     (AgentConnect)
--           'fin'           terminó la conversación               (AgentComplete)
--           'abandona'      el que llamaba colgó esperando        (QueueCallerAbandon)
--           'sin_respuesta' le sonó a un agente y no atendió      (AgentRingNoAnswer)
-- Las salidas por desborde o timeout NO tienen evento propio a propósito (ver el
-- encabezado de ccreport.js): se deducen como entradas − atendidas − abandonadas, así no
-- hay riesgo de contar dos veces la misma llamada.
CREATE TABLE IF NOT EXISTS pbxng_queue_events (
  id       bigserial PRIMARY KEY,
  ts       timestamptz NOT NULL DEFAULT now(),
  cola     text NOT NULL,
  evento   text NOT NULL,
  uniqueid text,                -- canal de quien llama: hila los eventos de una misma llamada
  agente   text,                -- membername del agente (o la interfaz si no tiene nombre)
  espera_s int,                 -- segundos en cola hasta que la atendieron o colgó (HoldTime)
  habla_s  int,                 -- segundos de conversación (TalkTime, sólo en 'fin')
  posicion int,
  origen   text,                -- CallerIDNum de quien llama
  motivo   text
);
CREATE INDEX IF NOT EXISTS pbxng_queue_events_ts   ON pbxng_queue_events (ts DESC);
CREATE INDEX IF NOT EXISTS pbxng_queue_events_cola ON pbxng_queue_events (cola, ts DESC);
CREATE INDEX IF NOT EXISTS pbxng_queue_events_ag   ON pbxng_queue_events (agente, ts DESC);

-- Envíos programados del informe. Una fila por envío: a quién, cada cuánto y con qué
-- umbral de nivel de servicio. `last_run_at` es la memoria anti-duplicado (el motor corre
-- cada minuto y sólo manda si todavía no mandó el de este día / semana / mes).
CREATE TABLE IF NOT EXISTS pbxng_cc_reports (
  id            serial PRIMARY KEY,
  nombre        text,
  cola          text,                                  -- vacío / NULL = todas las colas
  periodo       text NOT NULL DEFAULT 'diario',        -- diario | semanal | mensual
  hora          int  NOT NULL DEFAULT 8,               -- hora local de envío (0-23)
  dia           int,                                   -- semanal: 1=lunes…7=domingo · mensual: día del mes (1-28)
  sla_seg       int  NOT NULL DEFAULT 20,              -- «atendida antes de N segundos»
  destinatarios text NOT NULL DEFAULT '',              -- csv; vacío = el destinatario por defecto de alertas
  enabled       boolean NOT NULL DEFAULT true,
  last_run_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- El envío usa el motor de alerts.js (SMTP, marca, registro en pbxng_alerts y manejo de
-- errores ya resueltos ahí). La regla nace PRENDIDA, al revés que las alertas de aviso:
-- acá el interruptor real es `enabled` de cada programación, y un segundo interruptor
-- escondido en Notificaciones sólo serviría para que el informe "no llegue y no se sepa
-- por qué". El throttle queda en 0 porque cada programación ya se cuida sola.
INSERT INTO pbxng_alert_rules (event, enabled, params, throttle_min)
  VALUES ('ccreport.scheduled', true, '{}', 0)
ON CONFLICT (event) DO NOTHING;

-- Retención de los eventos de cola, en días (0 = no podar nunca).
INSERT INTO pbxng_settings (key, value) VALUES ('cc_retencion_dias', '365')
ON CONFLICT (key) DO NOTHING;
