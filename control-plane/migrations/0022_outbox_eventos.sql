-- PBX-NG · 0022 · Outbox de eventos salientes: la mitad «la central avisa» del contrato.
--
-- POR QUÉ: hasta acá PBX-NG tenía TODO lo necesario para saber qué pasa —el motor ARI
-- recibe los eventos de canal, el AMI da DialBegin/DialEnd con su `dialstatus`, el guard
-- detecta el ataque— y NADA para contarlo afuera. Cero eventos de negocio salientes: ni
-- `llamada.entrante`, ni `llamada.terminada`, ni `grabacion.lista`, ni webhooks. El
-- backoffice sólo podía preguntar, y preguntar cada dos segundos por si sonó un teléfono
-- no es una integración: es una encuesta que llega tarde y cuesta una conexión del pool.
--
-- POR QUÉ UNA TABLA Y NO UN POST DIRECTO: porque el POST se pierde. Si el destino está
-- caído, o el certificado venció, o hay 200 ms de red mala justo cuando terminó la
-- llamada, un `fetch` suelto se traga el evento y nadie se entera nunca. El patrón de
-- outbox es viejo y aburrido justamente porque funciona: el evento se escribe primero, se
-- entrega después, y mientras no haya acuse sigue ahí.
--
-- ORDEN: `secuencia` es global y creciente (serial). El orden que el contrato promete es
-- POR LLAMADA, no global: dos llamadas simultáneas pueden entregarse entrelazadas, pero
-- los eventos de UNA llamada llegan en orden. Prometer orden global obligaría a una sola
-- entrega a la vez para toda la central, y una central con 30 llamadas en curso se
-- quedaría atrás enseguida.
CREATE TABLE IF NOT EXISTS pbxng_eventos_salida (
  secuencia     bigserial PRIMARY KEY,
  evento_id     uuid NOT NULL,
  tipo          text NOT NULL,
  version       int  NOT NULL DEFAULT 1,
  ts            timestamptz NOT NULL DEFAULT now(),
  call_id       text,
  leg_id        text,
  datos         jsonb NOT NULL DEFAULT '{}'
);

-- `evento_id` es único: es la garantía de «exactamente una vez» del lado de quien recibe,
-- que puede descartarlo si ya lo vio. La unicidad la pone Postgres y no una caché en
-- memoria a propósito: el repo ya tiene tres dedup por Map que hacen `clear()` al pasar
-- el tope —o sea que olvidan TODO justo en el momento de más carga— y copiar ese patrón
-- acá sería reenviar eventos ya entregados exactamente cuando peor viene.
CREATE UNIQUE INDEX IF NOT EXISTS idx_eventos_id ON pbxng_eventos_salida (evento_id);
CREATE INDEX IF NOT EXISTS idx_eventos_call ON pbxng_eventos_salida (call_id, secuencia);
CREATE INDEX IF NOT EXISTS idx_eventos_ts ON pbxng_eventos_salida (ts);

-- A dónde se entrega. Una fila por destino: el backoffice de Horizon es uno, pero nada
-- impide un segundo consumidor (un tablero, un archivador) con su propia suscripción y su
-- propio ritmo — por eso el avance se guarda POR DESTINO y no como un flag en el evento.
--
-- `secreto` firma cada entrega (HMAC-SHA256 sobre el cuerpo): el que recibe puede
-- verificar que el POST salió de esta central y no de cualquiera que conozca la URL.
--
-- `cursor` es la última `secuencia` entregada con acuse. Reintentar es volver a leer desde
-- ahí: no hay estado por evento, así que no hay forma de que una fila quede «en vuelo»
-- para siempre si el proceso se muere en el medio.
CREATE TABLE IF NOT EXISTS pbxng_suscripciones (
  id            serial PRIMARY KEY,
  nombre        text NOT NULL,
  client_id     text REFERENCES pbxng_api_clients(client_id) ON DELETE SET NULL,
  url           text,
  secreto       text,
  tipos         text[] NOT NULL DEFAULT '{}',
  activa        boolean NOT NULL DEFAULT true,
  cursor        bigint NOT NULL DEFAULT 0,
  intentos      int NOT NULL DEFAULT 0,
  ultimo_error  text,
  ultimo_ok_at  timestamptz,
  proximo_at    timestamptz,
  creada_at     timestamptz NOT NULL DEFAULT now()
);

-- Una suscripción SIN `url` es válida y es el modo «el backoffice viene a buscar»
-- (GET /api/v1/eventos): sirve cuando el cliente no puede exponer un webhook, que es la
-- mitad de los casos reales detrás de un NAT corporativo.
CREATE INDEX IF NOT EXISTS idx_susc_activa ON pbxng_suscripciones (activa, proximo_at);
