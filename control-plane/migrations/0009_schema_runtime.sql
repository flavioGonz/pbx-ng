-- 0009 · Esquema que hasta 1.4.x se creaba EN TIEMPO DE EJECUCIÓN (app.js, ai-pipeline.js,
-- push-providers.js: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS al arrancar).
--
-- Por qué se muda acá: esos CREATE corrían en paralelo y sin esperar (promesas sueltas
-- con .catch(() => {})), así que una ruta podía atender antes de que existiera su tabla,
-- y un fallo de esquema quedaba en un log que nadie mira. Desde esta migración el entrypoint corre
-- `node migrate.js` ANTES de `node app.js`: si el esquema no se puede aplicar, el
-- contenedor no arranca (mejor que atender con esquema viejo).
--
-- Son los MISMOS DDL, en el mismo orden de dependencias, todos idempotentes: en una
-- instalación nueva initdb/01-schema.sql ya crea casi todo y esto no hace nada; en una
-- actualizada a mano completa lo que falte. Las filas semilla (rec_config id=1, net id=1,
-- admin, empresa, campos de encuesta) siguen en app.js: son datos, no esquema.

-- ── Configuración clave/valor (la usan casi todos los módulos) ─────────────────
CREATE TABLE IF NOT EXISTS pbxng_settings (key text PRIMARY KEY, value text);

-- ── Web Push (PWA) y push nativo (FCM/APNs) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS pbxng_push_subs (
  id serial PRIMARY KEY, ext text NOT NULL, endpoint text UNIQUE NOT NULL,
  p256dh text NOT NULL, auth text NOT NULL, ua text, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS pbxng_push_devices (id serial PRIMARY KEY, ext text, provider text, prid text, param text, topic text, ua text, updated_at timestamptz DEFAULT now(), UNIQUE(provider,prid));

-- ── Usuarios del panel: interno asociado y "cambiar clave en el primer ingreso" ──
ALTER TABLE pbxng_users ADD COLUMN IF NOT EXISTS ext text;
ALTER TABLE pbxng_users ADD COLUMN IF NOT EXISTS must_change boolean DEFAULT false;

-- ── Enrolamiento (QR / enlace) y su bitácora de activación ─────────────────────
CREATE TABLE IF NOT EXISTS pbxng_enroll (token text PRIMARY KEY, ext text, password text, label text, created_at timestamptz DEFAULT now(), expires_at timestamptz, used_at timestamptz);
ALTER TABLE pbxng_enroll ADD COLUMN IF NOT EXISTS activated_at timestamptz;
ALTER TABLE pbxng_enroll ADD COLUMN IF NOT EXISTS device text;
ALTER TABLE pbxng_enroll ADD COLUMN IF NOT EXISTS platform text;
ALTER TABLE pbxng_enroll ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE pbxng_enroll ADD COLUMN IF NOT EXISTS ip text;
ALTER TABLE pbxng_enroll ADD COLUMN IF NOT EXISTS uses int DEFAULT 0;

-- (pbxng_fail2ban / pbxng_fail2ban_cmd se creaban acá hasta 1.5.1: eran el estado de un
--  fail2ban que ninguna imagen instalaba. 0010_soc.sql las borra y trae el esquema del
--  módulo de seguridad real.)

-- ── Grabaciones (índice + transcripción/análisis) y su almacenamiento ──────────
CREATE TABLE IF NOT EXISTS pbxng_recordings (id serial PRIMARY KEY, filename text UNIQUE NOT NULL, ext text, src text, dst text, started_at timestamptz, bytes bigint DEFAULT 0, duration int DEFAULT 0, storage text DEFAULT 'local', remote_url text, linkedid text, deleted boolean DEFAULT false, created_at timestamptz DEFAULT now());
ALTER TABLE pbxng_recordings ADD COLUMN IF NOT EXISTS transcript text;
ALTER TABLE pbxng_recordings ADD COLUMN IF NOT EXISTS analysis jsonb;
ALTER TABLE pbxng_recordings ADD COLUMN IF NOT EXISTS transcribed_at timestamptz;
ALTER TABLE pbxng_recordings ADD COLUMN IF NOT EXISTS peaks jsonb;
CREATE TABLE IF NOT EXISTS pbxng_rec_config (id int PRIMARY KEY DEFAULT 1, backend text DEFAULT 'local', nas_path text, s3_endpoint text, s3_region text, s3_bucket text, s3_key text, s3_secret text, s3_prefix text DEFAULT 'recordings/', auto_upload boolean DEFAULT false, retain_local boolean DEFAULT true, updated_at timestamptz DEFAULT now());
ALTER TABLE pbxng_rec_config ADD COLUMN IF NOT EXISTS nas_type text DEFAULT 'mount', ADD COLUMN IF NOT EXISTS nas_server text, ADD COLUMN IF NOT EXISTS nas_share text, ADD COLUMN IF NOT EXISTS nas_user text, ADD COLUMN IF NOT EXISTS nas_pass text;

-- ── Audios (prompts TTS/subidos), correo saliente, integraciones ───────────────
CREATE TABLE IF NOT EXISTS pbxng_prompts (id serial PRIMARY KEY, name text UNIQUE NOT NULL, format text DEFAULT 'wav', bytes int DEFAULT 0, data bytea, deleted boolean DEFAULT false, updated_at timestamptz DEFAULT now(), synced_at timestamptz);
CREATE TABLE IF NOT EXISTS pbxng_email_config (tenant_id int PRIMARY KEY, host text, port int DEFAULT 587, secure boolean DEFAULT false, username text, password text, from_addr text, enabled boolean DEFAULT false, updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS pbxng_integrations (type text PRIMARY KEY, enabled boolean DEFAULT false, config jsonb DEFAULT '{}', updated_at timestamptz DEFAULT now());

-- ── Agentes de IA (IVR con IA) + columnas que agregaba ai-pipeline.js ──────────
CREATE TABLE IF NOT EXISTS pbxng_ai_agents (id serial PRIMARY KEY, name text, exten text, greeting text DEFAULT 'demo-congrats', system_prompt text DEFAULT '', voice text DEFAULT 'es-ES', provider text DEFAULT 'openai', model text DEFAULT 'gpt-4o-mini', enabled boolean DEFAULT true, created_at timestamptz DEFAULT now());
ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS sales_exten text;
ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS support_exten text;
ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS default_exten text;
ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS crm_webhook text;
ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS greeting_text text;

-- ── IVR (editor de flujo), troncales (tipo / config SBC), rutas ────────────────
ALTER TABLE pbxng_ivr ADD COLUMN IF NOT EXISTS flow jsonb;
ALTER TABLE pbxng_trunks ADD COLUMN IF NOT EXISTS kind text DEFAULT 'asterisk';
ALTER TABLE pbxng_trunks ADD COLUMN IF NOT EXISTS kam_config jsonb;
CREATE TABLE IF NOT EXISTS pbxng_outbound_routes (id serial PRIMARY KEY, name text, pattern text, trunk text, strip int DEFAULT 0, prepend text, callerid text, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS pbxng_ivr_audios (id serial PRIMARY KEY, name text UNIQUE, text text, voice text, ref text, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS pbxng_inbound_routes (id serial PRIMARY KEY, did text, name text, dest_type text, dest_value text, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS pbxng_directory (ext text PRIMARY KEY, name text, updated_at timestamptz DEFAULT now());

-- ── Click-to-call público ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pbxng_click2call (id serial PRIMARY KEY, token text UNIQUE, name text, dest_type text DEFAULT 'extension', dest_value text, intro text, require_name boolean DEFAULT true, collect_geo boolean DEFAULT false, video boolean DEFAULT false, enabled boolean DEFAULT true, tenant_id int DEFAULT 1, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS pbxng_c2c_sessions (id text PRIMARY KEY, link_id int, guest_ext text, dial_exten text, visitor_name text, geo text, meta text, created_at timestamptz DEFAULT now(), expires_at timestamptz);

-- ── Aprovisionamiento de teléfonos físicos, geolocalización de llamadas ────────
CREATE TABLE IF NOT EXISTS pbxng_phones (id serial PRIMARY KEY, mac text UNIQUE, vendor text, model text, ext text, label text, line_label text, password text, tenant_id int DEFAULT 1, last_seen timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS pbxng_call_geo (id serial PRIMARY KEY, ext text, number text, dir text, lat double precision, lng double precision, accuracy real, ua text, ts timestamptz DEFAULT now());

-- ── Capturas de paquetes, modo de red, música en espera, captura SIP ───────────
CREATE TABLE IF NOT EXISTS pbxng_captures (id serial PRIMARY KEY, node text, preset text, duration int, status text DEFAULT 'pending', filename text, size bigint DEFAULT 0, data bytea, error text, created_at timestamptz DEFAULT now(), started_at timestamptz, finished_at timestamptz);
CREATE TABLE IF NOT EXISTS pbxng_net (id int PRIMARY KEY DEFAULT 1, modo text DEFAULT 'router', wan_if text, lan_if text, nat boolean DEFAULT true, forward boolean DEFAULT true, bridge text DEFAULT 'br0', updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS pbxng_moh_classes (nombre text PRIMARY KEY, descripcion text, sort text DEFAULT 'alpha', announcement text, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS pbxng_sip_capture (id bigserial PRIMARY KEY, ts timestamptz DEFAULT now(), host text, src text, dst text, method text, status int, callid text, cseq text, from_uri text, to_uri text, ruri text, raw text);

-- ── CRM propio (clientes, personas, espacios, dispositivos) y encuestas ────────
-- pbxng_clients va antes que las tres que la referencian (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS pbxng_clients (
      id serial PRIMARY KEY, name text NOT NULL, doc text, address text, notes text,
      phones text[] DEFAULT '{}', created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
ALTER TABLE pbxng_clients ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE pbxng_clients ADD COLUMN IF NOT EXISTS lon double precision;
CREATE TABLE IF NOT EXISTS pbxng_client_persons (
      id serial PRIMARY KEY, client_id int REFERENCES pbxng_clients(id) ON DELETE CASCADE,
      name text NOT NULL, doc text, relation text, valid_until date, notes text, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS pbxng_client_spaces (
      id serial PRIMARY KEY, client_id int REFERENCES pbxng_clients(id) ON DELETE CASCADE,
      name text NOT NULL, kind text, notes text, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS pbxng_client_devices (
      id serial PRIMARY KEY, client_id int REFERENCES pbxng_clients(id) ON DELETE CASCADE,
      label text NOT NULL, type text DEFAULT 'camera', rtsp_url text, go2rtc_src text, enabled boolean DEFAULT true, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS pbxng_survey_fields (
      id serial PRIMARY KEY, ord int DEFAULT 0, label text NOT NULL, ftype text DEFAULT 'text',
      options jsonb DEFAULT '[]', required boolean DEFAULT false, active boolean DEFAULT true);
CREATE TABLE IF NOT EXISTS pbxng_call_surveys (
      id serial PRIMARY KEY, ext text, client_id int, caller text, uniqueid text,
      answers jsonb DEFAULT '{}', created_at timestamptz DEFAULT now());
