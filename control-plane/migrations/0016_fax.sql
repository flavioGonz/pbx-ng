-- PBX-NG · Fax T.38 (0016) · ítem 7 de docs/BRECHA-UCM-XORCOM.md, bloque B.
-- Lo genera y lo consume control-plane/fax.js.
--
-- QUÉ GUARDA Y QUÉ NO: acá viven la configuración, las cajas de fax, y el ÍNDICE de lo
-- recibido y lo enviado. Los archivos (TIFF que escribe Asterisk, PDF convertido) viven
-- en disco, en el volumen compartido con Asterisk (FAX_DIR, por defecto /recordings/fax),
-- igual que las grabaciones: un TIFF de veinte páginas en una columna `bytea` hace que el
-- respaldo lógico de la base pase de megabytes a gigabytes y que cualquier `SELECT *` del
-- panel se traiga el fax entero.
--
-- POR QUÉ EL ENVÍO ES UNA COLA Y NO UN BOTÓN: un fax que no entra a la primera es lo
-- NORMAL (ocupado, el otro lado es un teléfono, el módem no engancha). Sin cola, cada
-- fallo obliga a alguien a volver a subir el PDF; con cola el trabajo queda con su
-- `proximo_intento` y se reintenta solo hasta `max_intentos`.

-- ── Configuración (una sola fila) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pbxng_fax_config (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- CSID: el número propio que se le anuncia al otro aparato. Va impreso en la cabecera
  -- del fax del que recibe, así que si queda vacío el destinatario ve "unknown".
  station_id    text NOT NULL DEFAULT '',
  header        text NOT NULL DEFAULT '',
  ecm           boolean NOT NULL DEFAULT true,
  -- T.38: se pide por reinvite (`z` de SendFAX/ReceiveFAX) pero SIEMPRE con respaldo en
  -- audio (`f`). Una troncal sin T.38 —o un SBC en el medio que no lo pasa— tiene que
  -- seguir mandando faxes en G.711, no cortarlos.
  t38           boolean NOT NULL DEFAULT true,
  t38_ec        text NOT NULL DEFAULT 'redundancy',
  -- Troncales a las que se les aplica T.38 y, si `detect`, la detección de tono.
  -- Vacío = ninguna: no se toca la config de una troncal que nadie pidió tocar.
  trunks        jsonb NOT NULL DEFAULT '[]'::jsonb,
  detect        boolean NOT NULL DEFAULT false,
  detect_box    int,
  detect_seg    int NOT NULL DEFAULT 4,
  max_mb        int NOT NULL DEFAULT 10,
  max_paginas   int NOT NULL DEFAULT 50,
  reintentos    int NOT NULL DEFAULT 3,
  reintento_min int NOT NULL DEFAULT 5,
  dial_seg      int NOT NULL DEFAULT 60,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO pbxng_fax_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Cajas de fax (el destinatario de lo que entra) ──────────────────────────
-- Una ruta entrante marcada como fax apunta a una caja; la caja dice a qué correo va.
-- `email` admite varios separados por coma: en un estudio contable el fax lo mira más
-- de una persona y tener que crear dos cajas para el mismo número es absurdo.
CREATE TABLE IF NOT EXISTS pbxng_fax_boxes (
  id            serial PRIMARY KEY,
  nombre        text NOT NULL,
  email         text NOT NULL DEFAULT '',
  station_id    text,
  header        text,
  adjuntar_tiff boolean NOT NULL DEFAULT false,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Recibidos ───────────────────────────────────────────────────────────────
-- `uniqueid` es el del canal y es UNIQUE a propósito: el dialplan avisa por CURL al
-- terminar y el barrido del directorio importa lo que quedó sin aviso (una llamada que se
-- cortó justo ahí). Las dos vías pueden llegar al mismo fax y no puede entrar dos veces.
CREATE TABLE IF NOT EXISTS pbxng_fax_in (
  id          serial PRIMARY KEY,
  box_id      int REFERENCES pbxng_fax_boxes(id) ON DELETE SET NULL,
  uniqueid    text UNIQUE,
  cid         text,
  did         text,
  recibido_at timestamptz NOT NULL DEFAULT now(),
  paginas     int NOT NULL DEFAULT 0,
  estado      text NOT NULL DEFAULT 'ok',
  detalle     text,
  remoto      text,
  tiff        text,
  pdf         text,
  bytes       bigint NOT NULL DEFAULT 0,
  email_to    text,
  email_ok    boolean,
  email_err   text
);
CREATE INDEX IF NOT EXISTS idx_fax_in_fecha ON pbxng_fax_in (recibido_at DESC);

-- ── Enviados (la cola) ──────────────────────────────────────────────────────
-- `estado`: pendiente | enviando | ok | error | cancelado.
-- `enviando_desde` existe porque el aviso de fin lo manda el dialplan: si la llamada nunca
-- llegó a ejecutarlo (no atendió, se cayó el canal) el trabajo quedaría "enviando" para
-- siempre. El reloj de la cola lo destraba y lo cuenta como intento fallido.
CREATE TABLE IF NOT EXISTS pbxng_fax_out (
  id              serial PRIMARY KEY,
  numero          text NOT NULL,
  nombre          text,
  asunto          text,
  archivo         text NOT NULL,
  tiff            text,
  paginas         int NOT NULL DEFAULT 0,
  bytes           bigint NOT NULL DEFAULT 0,
  estado          text NOT NULL DEFAULT 'pendiente',
  intentos        int NOT NULL DEFAULT 0,
  max_intentos    int NOT NULL DEFAULT 3,
  proximo_intento timestamptz NOT NULL DEFAULT now(),
  enviando_desde  timestamptz,
  detalle         text,
  remoto          text,
  uniqueid        text,
  usuario         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fax_out_cola ON pbxng_fax_out (estado, proximo_intento);
