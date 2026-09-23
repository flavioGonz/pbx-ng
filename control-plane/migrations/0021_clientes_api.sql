-- PBX-NG · 0021 · Credencial de SISTEMA (no de persona) para la API pública.
--
-- POR QUÉ: hasta acá la única forma de entrar a la API era una sesión de panel —un
-- usuario de `pbxng_users` con su contraseña— o el token del softphone. Los dos están
-- pensados para una PERSONA. El backoffice de Horizon no es una persona: es un sistema
-- que corre sin nadie mirando, que no puede cambiar una contraseña que venció, y al que
-- hay que poder cortarle el acceso sin tocar a nadie más.
--
-- Lo que se hizo mal en otros lados y acá no se hace:
--   · un usuario «api» con rol admin: el día que se filtra, entra a TODO, y revocarlo es
--     borrar un usuario que además aparece en las bitácoras como si fuera alguien;
--   · una API key fija en el `.env`: no se puede rotar sin reiniciar, no se puede tener
--     más de un consumidor, y no queda registro de cuál se usó;
--   · guardar el secreto en claro: si alguien lee la base, ya entró a la central.
--
-- Forma: `client_id` público + secreto que se muestra UNA vez y se guarda hasheado con
-- bcrypt (el mismo costo que las contraseñas de usuario, `auth.js`). El token que se
-- emite es corto (1 h) y se verifica CONTRA ESTA TABLA en cada pedido, no sólo por firma:
-- así revocar es un UPDATE que corta el acceso al instante, sin esperar a que venza nada.
--
-- Los alcances son una lista explícita —deny-by-default, igual que `rbac.js`—: un cliente
-- que sólo tiene `cdr:leer` no puede originar una llamada aunque conozca la ruta. Se
-- guardan como texto[] y los valores válidos los declara `clientes-api.js`, que es el
-- único que los interpreta.
CREATE TABLE IF NOT EXISTS pbxng_api_clients (
  client_id     text PRIMARY KEY,
  nombre        text NOT NULL,
  secreto_hash  text NOT NULL,
  alcances      text[] NOT NULL DEFAULT '{}',
  notas         text,
  creado_at     timestamptz NOT NULL DEFAULT now(),
  creado_por    text,
  revocado_at   timestamptz,
  usado_at      timestamptz,
  usado_ip      text
);

-- La lista del panel ordena por «último uso» para que el que dejó de llamar salte a la
-- vista: un consumidor que se calló hace tres días es, casi siempre, una integración rota
-- que nadie reportó.
CREATE INDEX IF NOT EXISTS idx_api_clients_usado ON pbxng_api_clients (usado_at DESC NULLS LAST);

-- Idempotencia de las escrituras del backoffice (B5 de la auditoría de entrega). Vive
-- acá y no en memoria porque tiene que sobrevivir al reinicio del contenedor: si el
-- backoffice reintenta un `POST /calls/dial` porque se le cortó la red justo después de
-- que la llamada salió, la respuesta guardada es lo único que evita llamar dos veces al
-- mismo cliente.
--
-- La clave es (cliente, key): dos consumidores distintos pueden usar la misma `key` sin
-- pisarse. `huella` es el hash del cuerpo del pedido: la misma key con OTRO cuerpo es un
-- error del que llama (409), no una respuesta cacheada — si no, un bug del backoffice que
-- reusa la key se convertiría en «la central me contesta cualquier cosa».
CREATE TABLE IF NOT EXISTS pbxng_idempotencia (
  client_id   text NOT NULL,
  clave       text NOT NULL,
  huella      text NOT NULL,
  estado      int,
  cuerpo      jsonb,
  creado_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, clave)
);

-- La poda corre en la API (24 h de retención); el índice es para que barrer sea barato
-- aunque la tabla tenga un día entero de escrituras.
CREATE INDEX IF NOT EXISTS idx_idem_creado ON pbxng_idempotencia (creado_at);
