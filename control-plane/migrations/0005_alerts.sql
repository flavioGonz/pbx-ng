-- Motor de alertas por correo: reglas configurables + historial + memoria de estado.
CREATE TABLE IF NOT EXISTS pbxng_alert_rules (
  event       text PRIMARY KEY,             -- security.ban, auth.login, trunk.down, ...
  enabled     boolean NOT NULL DEFAULT false,
  recipients  text,                         -- csv de destinatarios (vacio = usa el default)
  params      jsonb NOT NULL DEFAULT '{}',  -- umbrales por evento
  throttle_min integer NOT NULL DEFAULT 15, -- no repetir la misma alerta antes de N minutos
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pbxng_alerts (
  id        bigserial PRIMARY KEY,
  event     text NOT NULL,
  severity  text NOT NULL DEFAULT 'info',   -- info | warn | crit
  title     text NOT NULL,
  detail    jsonb NOT NULL DEFAULT '{}',
  to_addr   text,
  sent      boolean NOT NULL DEFAULT false,
  err       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pbxng_alerts_ts ON pbxng_alerts (created_at DESC);
CREATE TABLE IF NOT EXISTS pbxng_alert_state (
  key   text PRIMARY KEY,                   -- memoria del motor (IPs ya avisadas, estado previo, etc.)
  value jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- destinatario por defecto (se toma de pbxng_settings.alert_to)
INSERT INTO pbxng_settings (key, value) VALUES ('alert_to','') ON CONFLICT (key) DO NOTHING;

-- catalogo inicial (todo apagado: el admin decide que quiere recibir)
INSERT INTO pbxng_alert_rules (event, enabled, params, throttle_min) VALUES
  ('security.attack',   false, '{"failed":20,"window_min":10}', 30),
  ('security.ban',      false, '{}', 5),
  ('auth.login',        false, '{"only_new_ip":true}', 0),
  ('auth.login_failed', false, '{"attempts":3,"window_min":10}', 15),
  ('trunk.down',        false, '{}', 10),
  ('service.down',      false, '{}', 10),
  ('extension.offline', false, '{"exts":"","minutes":10}', 30),
  ('fraud.long_call',   false, '{"minutes":30}', 5),
  ('fraud.after_hours', false, '{"calls":5,"window_min":30,"from_hour":22,"to_hour":6}', 60),
  ('fraud.international', false, '{"prefixes":"00,+","allow":""}', 30),
  ('queue.no_agents',   false, '{"from_hour":9,"to_hour":18}', 60),
  ('digest.daily',      false, '{"hour":8}', 0)
ON CONFLICT (event) DO NOTHING;
