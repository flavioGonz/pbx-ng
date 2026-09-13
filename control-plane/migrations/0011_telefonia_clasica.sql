-- 0011 · Telefonía clásica de oficina (sprint 6, bloque A de docs/BRECHA-UCM-XORCOM.md):
-- horarios y modo noche, desvíos / DND / sígueme por interno y catálogo editable de
-- códigos de función. Lo sirve control-plane/telefonia.js.
--
-- Principio: PostgreSQL es la fuente de verdad y Asterisk lee el estado en caliente de la
-- AstDB (DB(dnd/<ext>), DB(cfu/<ext>)…), igual que ya se hace con la grabación (DB(rec/…)).
-- Así cambiar un desvío no recarga el dialplan ni reconstruye la imagen: la API escribe
-- las dos cosas (Postgres + AstDB por AMI) y al arrancar vuelca Postgres → AstDB.
--
-- Idempotente: todo va con IF NOT EXISTS / ON CONFLICT, se puede correr sobre una base
-- que ya tenga parte del esquema.

-- Desvíos, DND y sígueme por interno. `ext` es el id del endpoint (= el interno), sin FK
-- a ps_endpoints a propósito: borrar un interno no tiene por qué fallar por esta tabla y
-- la fila huérfana no molesta a nadie (la AstDB se limpia en el mismo borrado).
CREATE TABLE IF NOT EXISTS pbxng_ext_features (
  ext        text PRIMARY KEY,
  dnd        boolean NOT NULL DEFAULT false,
  cfu        text,                              -- desvío incondicional (destino) — vacío = apagado
  cfb        text,                              -- si ocupado
  cfnr       text,                              -- si no contesta
  fm         text,                              -- sígueme: número externo, sale por ruta saliente
  fm_seg     int NOT NULL DEFAULT 15,           -- segundos de timbrado antes del sígueme
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Horarios de atención. `tramos` es un arreglo de {dias, desde, hasta} en el formato que
-- entiende GotoIfTime: [{"dias":"mon-fri","desde":"09:00","hasta":"18:00"}].
CREATE TABLE IF NOT EXISTS pbxng_horarios (
  id     serial PRIMARY KEY,
  nombre text,
  tramos jsonb NOT NULL DEFAULT '[]',
  activo boolean NOT NULL DEFAULT true
);

-- Feriados: anuales (md = 'MM-DD', se repiten todos los años) o puntuales (fecha exacta).
CREATE TABLE IF NOT EXISTS pbxng_feriados (
  id     serial PRIMARY KEY,
  md     text,
  fecha  date,
  nombre text,
  anual  boolean NOT NULL DEFAULT true
);

-- Catálogo de códigos de función. La PK es la ACCIÓN (lo que hace), no el código: el
-- código lo edita el administrador desde el panel y tiene que poder cambiar sin perder
-- qué genera. `enabled=false` = la acción existe pero no se publica en el dialplan.
CREATE TABLE IF NOT EXISTS pbxng_featurecodes (
  accion  text PRIMARY KEY,
  code    text UNIQUE NOT NULL,
  nombre  text,
  enabled boolean NOT NULL DEFAULT true
);

-- Rutas entrantes: horario asignado y destino fuera de hora. Sin horario_id la ruta se
-- genera como hasta ahora (una sola extensión en from-trunk, sin ramas).
ALTER TABLE pbxng_inbound_routes ADD COLUMN IF NOT EXISTS horario_id int;
ALTER TABLE pbxng_inbound_routes ADD COLUMN IF NOT EXISTS dest_cerrado_type text;
ALTER TABLE pbxng_inbound_routes ADD COLUMN IF NOT EXISTS dest_cerrado_value text;

-- Semilla del catálogo: los códigos por defecto del sprint 6 más los cuatro que ya
-- existían fijos en apps.js (*43, *65, *97, *98), ahora editables como el resto.
-- ON CONFLICT DO NOTHING: si alguien ya cambió un código, esta migración no lo pisa.
INSERT INTO pbxng_featurecodes (accion, code, nombre) VALUES
  ('dnd_on',   '*78',    'No molestar: activar'),
  ('dnd_off',  '*79',    'No molestar: desactivar'),
  ('cfu_set',  '_*21*.', 'Desvío incondicional a un destino'),
  ('cfu_off',  '*21',    'Desvío incondicional: apagar'),
  ('cfb_set',  '_*22*.', 'Desvío si ocupado a un destino'),
  ('cfb_off',  '*22',    'Desvío si ocupado: apagar'),
  ('cfnr_set', '_*23*.', 'Desvío si no contesta a un destino'),
  ('cfnr_off', '*23',    'Desvío si no contesta: apagar'),
  ('fm_set',   '_*24*.', 'Sígueme a un número externo'),
  ('fm_off',   '*24',    'Sígueme: apagar'),
  ('night',    '*28',    'Modo noche: alternar abierto/cerrado'),
  ('eco',      '*43',    'Prueba de eco'),
  ('midigito', '*65',    'Decir mi número'),
  ('vm_propio','*97',    'Mi buzón de voz'),
  ('vm_otro',  '*98',    'Buzón de voz (otro interno)')
ON CONFLICT (accion) DO NOTHING;
