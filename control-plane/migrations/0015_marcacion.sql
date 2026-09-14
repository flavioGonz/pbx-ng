-- PBX-NG · Sprint 7 (0015) · DISA, callback, dial-by-name y marcación abreviada
-- (ítem 12 de docs/BRECHA-UCM-XORCOM.md). Lo genera y lo consume control-plane/marcacion.js.
--
-- POR QUÉ TODO NACE APAGADO (`enabled boolean NOT NULL DEFAULT false`): DISA y callback son,
-- desde hace treinta años, la puerta clásica del fraude de tarifación. Una DISA con PIN débil
-- o sin restricción de rutas es una central que cualquiera del mundo usa para llamar a
-- internacional a costa del cliente, y el callback es lo mismo con la llamada al revés.
-- Una actualización NUNCA debe encender solo algo que gasta plata: se enciende a mano,
-- después de ponerle PIN y elegir por qué rutas puede salir.

-- ── DISA ────────────────────────────────────────────────────────────────────
-- `pin_hash` es bcrypt y NO viaja al dialplan: el PIN se valida con un CURL a
-- /api/internal/disa (loopback + token del agente), igual que los códigos de función
-- avisan a /api/internal/feature. Así el PIN no queda en la tabla `extensions` (que se ve
-- con `dialplan show` y se respalda en claro) ni en la AstDB, y el conteo de intentos y el
-- bloqueo viven donde se pueden contar de verdad.
-- `rutas` es la lista de ids de pbxng_outbound_routes que esta DISA puede usar: vacía =
-- no puede salir a la calle. No es un campo de texto libre a propósito.
CREATE TABLE IF NOT EXISTS pbxng_disa (
  id           serial PRIMARY KEY,
  nombre       text NOT NULL,
  exten        text UNIQUE NOT NULL,
  pin_hash     text NOT NULL,
  enabled      boolean NOT NULL DEFAULT false,
  rutas        jsonb NOT NULL DEFAULT '[]'::jsonb,
  internos     boolean NOT NULL DEFAULT false,
  callerid     text,
  max_intentos int NOT NULL DEFAULT 3,
  bloqueo_min  int NOT NULL DEFAULT 15,
  dur_seg      int NOT NULL DEFAULT 300,
  dial_seg     int NOT NULL DEFAULT 60,
  max_digitos  int NOT NULL DEFAULT 20,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Callback ────────────────────────────────────────────────────────────────
-- `modo`: 'lista' (sólo números de la lista blanca), 'pin' (cualquier origen que sepa el
-- PIN) o 'lista_pin' (las dos cosas). El CallerID de quien llama se puede falsear, así que
-- 'pin' a secas equivale a "quien sepa el PIN hace que la central llame a donde quiera":
-- por eso el default es 'lista' y el alta exige lista blanca salvo que se pida 'pin'.
CREATE TABLE IF NOT EXISTS pbxng_callback (
  id           serial PRIMARY KEY,
  nombre       text NOT NULL,
  exten        text UNIQUE NOT NULL,
  enabled      boolean NOT NULL DEFAULT false,
  modo         text NOT NULL DEFAULT 'lista',
  pin_hash     text,
  numeros      jsonb NOT NULL DEFAULT '[]'::jsonb,
  demora_seg   int NOT NULL DEFAULT 5,
  cooldown_seg int NOT NULL DEFAULT 60,
  max_dia      int NOT NULL DEFAULT 20,
  dest_type    text NOT NULL DEFAULT 'disa',
  dest_value   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Registro de uso de las dos. Requisito, no adorno: sin el CallerID de origen de cada
-- intento no hay forma de darse cuenta de que te están probando el PIN hasta que llega
-- la factura. `familia` = 'disa' | 'callback'.
CREATE TABLE IF NOT EXISTS pbxng_marcacion_log (
  id       bigserial PRIMARY KEY,
  ts       timestamptz NOT NULL DEFAULT now(),
  familia  text NOT NULL,
  ref_id   int,
  cid      text,
  evento   text NOT NULL,
  destino  text,
  motivo   text
);
CREATE INDEX IF NOT EXISTS pbxng_marcacion_log_ts ON pbxng_marcacion_log (ts DESC);
CREATE INDEX IF NOT EXISTS pbxng_marcacion_log_cid ON pbxng_marcacion_log (familia, cid, ts DESC);

-- ── Dial-by-name ────────────────────────────────────────────────────────────
-- Una sola entrada (el directorio es de la central). `opciones` son las de Directory():
-- 'e' locuta el interno, 'f'/'l' buscar por nombre o apellido, 'b' por los dos.
-- El contexto donde marca es SIEMPRE `internal` y no se configura: es lo único que entra
-- al dialplan desde esta tabla y no hay motivo para que el usuario lo escriba.
CREATE TABLE IF NOT EXISTS pbxng_dialbyname (
  id         serial PRIMARY KEY,
  exten      text UNIQUE NOT NULL,
  enabled    boolean NOT NULL DEFAULT false,
  opciones   text NOT NULL DEFAULT 'e',
  vm_context text NOT NULL DEFAULT 'default'
);

-- ── Marcación abreviada ─────────────────────────────────────────────────────
-- `ext IS NULL` = número corto GLOBAL de la central (se publica como extensión propia en
-- el dialplan `internal`); `ext` con valor = abreviado PERSONAL de ese interno, que no
-- ocupa dialplan: se marca `<prefijo><NN>` y el destino sale de la AstDB (`abrev/<ext>-<NN>`),
-- igual que los desvíos. Dos índices parciales porque en Postgres dos NULL no chocan y
-- UNIQUE(ext, code) dejaría repetir un código global.
CREATE TABLE IF NOT EXISTS pbxng_abreviados (
  id      serial PRIMARY KEY,
  ext     text,
  code    text NOT NULL,
  destino text NOT NULL,
  nombre  text
);
CREATE UNIQUE INDEX IF NOT EXISTS pbxng_abreviados_global ON pbxng_abreviados (code) WHERE ext IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pbxng_abreviados_propio ON pbxng_abreviados (ext, code) WHERE ext IS NOT NULL;
