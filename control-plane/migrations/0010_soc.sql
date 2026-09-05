-- 0010 · Centro de seguridad (/seguridad, control-plane/guard.js).
--
-- Reemplaza el "fail2ban" que nunca existió (pbxng_fail2ban / pbxng_fail2ban_cmd eran
-- tablas que ningún agente llenaba) por el esquema del módulo real: bloqueos aplicados
-- en nftables por el agente de Asterisk, línea de tiempo de eventos y geo-bloqueo.
-- Mismo modelo que sbc_blocked / sbc_events / sbc_geoblock de SBC-NG, así el panel es
-- un clon (docs/CONTRATOS.md §3 y §5).

-- IPs bloqueadas (copia persistente de lo que hay en el set `banned` de nftables)
CREATE TABLE IF NOT EXISTS pbxng_blocked (
  ip         text PRIMARY KEY,
  reason     text,
  country    text,
  cc         text,
  isp        text,
  hits       int NOT NULL DEFAULT 1,           -- veces que se la bloqueó (o golpes estando bloqueada)
  permanent  boolean NOT NULL DEFAULT false,
  blocked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz                        -- NULL = permanente
);
CREATE INDEX IF NOT EXISTS pbxng_blocked_expires_idx ON pbxng_blocked (expires_at) WHERE expires_at IS NOT NULL;

-- Línea de tiempo: bloqueo | desbloqueo | ataque | geo | ajustes | motor, y `fallo`
-- (fallos agregados por IP cada 15 s: detail {ip, n, tipos, cuentas, cc, pais})
CREATE TABLE IF NOT EXISTS pbxng_sec_events (
  id         serial PRIMARY KEY,
  kind       text NOT NULL,
  severity   text NOT NULL DEFAULT 'info',     -- info | warn | crit
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pbxng_sec_events_created_idx ON pbxng_sec_events (created_at DESC);
CREATE INDEX IF NOT EXISTS pbxng_sec_events_kind_idx ON pbxng_sec_events (kind, created_at DESC);

-- Filtro por país (ISO-3166-1 alpha-2). El modo (bloquear | permitir) vive en
-- pbxng_settings.sec_geoblock_modo.
CREATE TABLE IF NOT EXISTS pbxng_geoblock (
  cc         char(2) PRIMARY KEY,
  nombre     text,
  added_at   timestamptz NOT NULL DEFAULT now()
);

-- Lista blanca (IP o CIDR): la crea initdb/01-schema.sql en una instalación nueva; en una
-- actualizada a mano podría faltar y guard.js la lee en cada arranque.
CREATE TABLE IF NOT EXISTS pbxng_f2b_whitelist (
  ip         text PRIMARY KEY,
  note       text,
  created_at timestamptz DEFAULT now()
);

DROP TABLE IF EXISTS pbxng_fail2ban_cmd;
DROP TABLE IF EXISTS pbxng_fail2ban;
