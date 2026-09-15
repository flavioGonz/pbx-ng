-- PBX-NG · Retiro del fax (0018) · decisión de producto, no técnica: el fax sale del
-- producto (ver CHANGELOG 1.11.0 y el ítem 7 de docs/BRECHA-UCM-XORCOM.md).
--
-- POR QUÉ ESTA MIGRACIÓN Y NO UN SIMPLE `DROP TABLE`: el fax no vivía sólo en sus cuatro
-- tablas. Dejaba dialplan publicado en `extensions` (que es la tabla realtime que LEE
-- Asterisk, no un archivo que se regenera al arrancar), podía ser el destino de una ruta
-- entrante y era el único que escribía las columnas T.38 del endpoint de una troncal.
-- Borrar sólo las tablas dejaba un DID saltando a `from-trunk,fax-rx-<n>` —una extensión
-- que ya no existe—: el que llama escucha silencio y cuelga, y en el panel la ruta se ve
-- perfecta. Por eso acá se limpian las tres cosas en la misma transacción.
--
-- ES IDEMPOTENTE Y NO FALLA SI NO HAY NADA: todo va con `IF EXISTS` / `to_regclass`,
-- porque una central instalada antes de 1.10.0 nunca tuvo estas tablas y una instalada
-- después casi seguro nunca las usó (el fax se agregó entero en 1.10.0 y no se activó en
-- ninguna instalación). Correrla dos veces no hace nada la segunda.

-- ── 1) Rutas entrantes que apuntaban a una caja de fax ──────────────────────
-- Fuera de hora es el caso fácil: se le saca el destino y la ruta sigue siendo válida,
-- porque una ruta con horario y sin destino cerrado ya tiene comportamiento propio
-- (buzón del interno, o saludo + colgar), el mismo que escribe `filasCerrado()` de
-- trunks.js. Acá se reescribe la rama `cerrado-<did>` a mano porque NADA regenera el
-- dialplan de las rutas entrantes al arrancar: queda como esté hasta que alguien toque
-- esa ruta o un horario.
--
-- OJO CON LA CONDICIÓN: `escribirEntrante()` publica las ramas `abierto-`/`cerrado-` SÓLO
-- cuando la ruta tiene un horario ACTIVO y con tramos; si no, todo el dialplan de la ruta
-- vive en la extensión del DID y las dos ramas se borran. Una migración que escriba una
-- rama `cerrado-` donde el código nunca la habría escrito deja dialplan que nadie va a
-- regenerar y que no se corresponde con lo que muestra el panel, así que acá se replica
-- exactamente la misma condición (`ruta_con_horario`).
CREATE OR REPLACE FUNCTION pg_temp.ruta_con_horario(h int) RETURNS boolean AS $fn$
  SELECT EXISTS (SELECT 1 FROM pbxng_horarios
                  WHERE id = h AND activo IS NOT FALSE AND jsonb_array_length(tramos) > 0);
$fn$ LANGUAGE sql STABLE;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, did, dest_type, dest_value, horario_id FROM pbxng_inbound_routes
            WHERE dest_cerrado_type = 'fax' LOOP
    DELETE FROM extensions WHERE context = 'from-trunk' AND exten = 'cerrado-' || r.did;
    IF pg_temp.ruta_con_horario(r.horario_id) THEN
      IF COALESCE(r.dest_type, 'interno') = 'interno' THEN
        INSERT INTO extensions (context, exten, priority, app, appdata) VALUES
          ('from-trunk', 'cerrado-' || r.did, 1, 'Answer', ''),
          ('from-trunk', 'cerrado-' || r.did, 2, 'Voicemail', r.dest_value || '@default,u'),
          ('from-trunk', 'cerrado-' || r.did, 3, 'Hangup', '');
      ELSE
        INSERT INTO extensions (context, exten, priority, app, appdata) VALUES
          ('from-trunk', 'cerrado-' || r.did, 1, 'Answer', ''),
          ('from-trunk', 'cerrado-' || r.did, 2, 'Playback', 'vm-goodbye'),
          ('from-trunk', 'cerrado-' || r.did, 3, 'Hangup', '');
      END IF;
    END IF;
    UPDATE pbxng_inbound_routes SET dest_cerrado_type = NULL, dest_cerrado_value = NULL WHERE id = r.id;
    RAISE NOTICE 'ruta entrante % (DID %): el destino FUERA DE HORA era una caja de fax; queda sin destino de fuera de hora', r.id, r.did;
  END LOOP;
END $$;

-- El destino PRINCIPAL no tiene un equivalente automático: un DID que entraba derecho a
-- una caja de fax no tiene a quién sonarle. Elegir un interno cualquiera sería mandarle
-- las llamadas de un desconocido al teléfono de alguien, así que el DID pasa a un IVR
-- —el único tipo de destino que por definición atiende a cualquiera— y, si la central no
-- tiene ningún IVR, la ruta se borra junto con su dialplan. En los dos casos queda un
-- NOTICE en el log de la migración (migrate.js engancha el evento `notice` de node-pg
-- justamente para esto) y el administrador lo ve en «Rutas entrantes».
--
-- CUÁL IVR: se toma el de menor id, pero eso NO es «la operadora». El id más bajo es
-- simplemente el IVR más viejo y puede ser un menú interno o uno de prueba; la central no
-- tiene ningún campo que diga cuál es el principal. Por eso el aviso cambia según el caso:
-- con un solo IVR la elección no tiene alternativa, y con varios se dice explícitamente
-- que la elección es provisoria y hay que revisarla. Se elige igual en vez de borrar la
-- ruta porque un DID que atiende en el menú equivocado se arregla con dos clics, y un DID
-- borrado no atiende a nadie y nadie se entera.
DO $$
DECLARE r record; ivr_ext text; ivr_n int; exten_dest text;
BEGIN
  SELECT exten INTO ivr_ext FROM pbxng_ivr ORDER BY id LIMIT 1;
  SELECT count(*) INTO ivr_n FROM pbxng_ivr;
  FOR r IN SELECT id, did, horario_id FROM pbxng_inbound_routes WHERE dest_type = 'fax' LOOP
    IF ivr_ext IS NULL THEN
      DELETE FROM extensions WHERE context = 'from-trunk'
        AND exten IN (r.did, 'abierto-' || r.did, 'cerrado-' || r.did);
      DELETE FROM pbxng_inbound_routes WHERE id = r.id;
      RAISE NOTICE 'ruta entrante % (DID %): entraba a una caja de fax y esta central no tiene IVR; se borra la ruta, hay que darle un destino nuevo al DID', r.id, r.did;
    ELSE
      -- Con horario activo y con tramos el destino normal vive en `abierto-<did>`; en
      -- cualquier otro caso (sin horario, horario apagado o sin tramos) vive en el DID.
      exten_dest := CASE WHEN pg_temp.ruta_con_horario(r.horario_id) THEN 'abierto-' || r.did ELSE r.did END;
      DELETE FROM extensions WHERE context = 'from-trunk' AND exten = exten_dest;
      INSERT INTO extensions (context, exten, priority, app, appdata)
        VALUES ('from-trunk', exten_dest, 1, 'Goto', 'ivr,' || ivr_ext || ',1');
      UPDATE pbxng_inbound_routes SET dest_type = 'ivr', dest_value = ivr_ext WHERE id = r.id;
      IF ivr_n = 1 THEN
        RAISE NOTICE 'ruta entrante % (DID %): entraba a una caja de fax; pasa al IVR %, el unico de la central', r.id, r.did, ivr_ext;
      ELSE
        RAISE NOTICE 'ruta entrante % (DID %): entraba a una caja de fax; queda provisoriamente en el IVR % (el mas viejo de los % que hay); REVISAR que sea el menu correcto', r.id, r.did, ivr_ext, ivr_n;
      END IF;
    END IF;
  END LOOP;
END $$;

-- ── 2) Dialplan del fax ─────────────────────────────────────────────────────
-- `fax-rx-<caja>` (ReceiveFAX de cada caja), `fax` (a donde chan_pjsip mandaba la llamada
-- cuando detectaba el tono CNG) y `fax-tx` (SendFAX de la cola de salida). Sin esto queda
-- dialplan marcable que llama a aplicaciones que la imagen de Asterisk ya no trae, y
-- `fax-tx` además seguiría ocupando un número del contexto compartido `internal`.
DELETE FROM extensions WHERE context = 'from-trunk' AND (exten = 'fax' OR exten LIKE 'fax-rx-%');
DELETE FROM extensions WHERE context = 'internal' AND exten = 'fax-tx';

-- ── 3) T.38 en los endpoints de las troncales ───────────────────────────────
-- El módulo de fax era el ÚNICO que escribía estas columnas (y sólo sobre troncales,
-- nunca sobre internos: por eso el filtro por `pbxng_kind`). Se apagan porque negociar
-- T.38 en una central que ya no sabe recibir un fax es pedirle al proveedor un reinvite
-- que después no se contesta. Sólo se tocan las que están prendidas, así la migración es
-- idempotente y no ensucia el resto de la configuración del endpoint.
UPDATE ps_endpoints
   SET t38_udptl = 'no'::ast_bool_values, fax_detect = 'no'::ast_bool_values,
       t38_udptl_ec = NULL, t38_udptl_maxdatagram = NULL, fax_detect_timeout = NULL
 WHERE pbxng_kind = 'trunk'
   AND (t38_udptl = 'yes'::ast_bool_values OR fax_detect = 'yes'::ast_bool_values);

-- ── 4) Las tablas ───────────────────────────────────────────────────────────
-- En este orden por la FK de `pbxng_fax_in` contra `pbxng_fax_boxes`. Los documentos
-- (TIFF y PDF) viven en disco, en el spool (`FAX_DIR`, un subdirectorio del volumen
-- `recordings`): esta migración NO los borra a propósito —un fax recibido es un documento
-- del cliente y borrarle archivos desde una migración no se deshace—. Si la central llegó
-- a recibir alguno, queda en `/recordings/fax` para llevárselo a mano.
DROP TABLE IF EXISTS pbxng_fax_in;
DROP TABLE IF EXISTS pbxng_fax_out;
DROP TABLE IF EXISTS pbxng_fax_boxes;
DROP TABLE IF EXISTS pbxng_fax_config;
