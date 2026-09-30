-- PBX-NG · 0029 · IA EXTERNA: el agente lo conduce otro sistema (el backend del asistente).
--
-- POR QUÉ UN PROVEEDOR MÁS Y NO UN AGENTE NUESTRO: en este perfil la central no decide
-- nada de la conversación. Atiende, pone el audio y ejecuta órdenes (colgar, transferir,
-- mandar un DTMF). Qué decir, cuándo verificar, abrir o derivar lo decide el backend, que
-- controla la sesión por el relay (ia-externa.js). Por eso el agente no usa su prompt, su
-- saludo, sus herramientas ni su escalera de inactividad: lo hace el backend.
--
-- Lo que se reusa de lo que ya existe, para no duplicar configuración:
--   default_exten              el destino de RESPALDO (sin backend o sin configuración)
--   herramientas.abrir_porton  el DTMF de apertura del portero ("dtmf": "#")
ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS externo_url    text;
-- El token compartido con el backend. Va en el agente, como el token del backoffice
-- (herramientas.remoto.token).
ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS externo_token  text;
-- A dónde se transfiere cuando el backend DERIVA a una persona (una cola o un interno).
ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS agentes_exten  text;

-- La configuración de la sesión que publica el backend, bajada y guardada. Se guarda en
-- la base y no sólo en memoria para que un reinicio de la API no deje al agente sin
-- configuración hasta que el backend avise: con la guardada se sigue atendiendo.
CREATE TABLE IF NOT EXISTS pbxng_ia_externa_config (
  agente_id          int PRIMARY KEY REFERENCES pbxng_ai_agents(id) ON DELETE CASCADE,
  version            text        NOT NULL,
  session            jsonb       NOT NULL,
  attach_timeout_ms  int         NOT NULL DEFAULT 5000,
  bajada_at          timestamptz NOT NULL DEFAULT now()
);
