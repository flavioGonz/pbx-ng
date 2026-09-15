-- PBX-NG · 0019 · El coturn propio viene ENCENDIDO DE FÁBRICA + origen del TURN.
--
-- POR QUÉ: medido en una central real en producción. `/api/ice` le repartía a siete
-- softphones WebRTC la dirección `turn:<dominio>:3478` de un coturn que NADIE estaba
-- corriendo (el perfil `turn` nunca se levantó porque `COMPOSE_PROFILES` estaba vacío),
-- mientras el panel mostraba el módulo «TURN/STUN» encendido. El switch mentía por una
-- razón concreta: `moduleEnabled()` devuelve true cuando NO hay fila en `pbxng_settings`,
-- y el reconciliador (`docker/pbxng-reconciler.sh`) salteaba justo ese caso
-- (`[ -z "$v" ] && continue`). O sea: el default existía en la API y no llegaba nunca al
-- contenedor. Nadie encendía el módulo porque para todo el mundo ya estaba encendido.
--
-- Sin TURN, un softphone detrás de un NAT simétrico se queda sin audio: eso es ROTO, no
-- mejorable, así que el relay propio es parte de PBX-NG y no un extra. Esta migración
-- hace explícito ese default: deja la fila escrita para que la vean por igual el panel,
-- la API y el reconciliador, en vez de que cada uno lo adivine por su cuenta.
--
-- NO se toca una central que YA decidió apagarlo: si hay fila `mod_turn`, se respeta
-- (sea '1' o '0'). Sólo se escribe donde no había ninguna.
INSERT INTO pbxng_settings (key, value)
SELECT 'mod_turn', '1'
 WHERE NOT EXISTS (SELECT 1 FROM pbxng_settings WHERE key = 'mod_turn')
ON CONFLICT (key) DO NOTHING;

-- Origen del TURN que se le declara a los clientes. UNO SOLO a la vez:
--   propio  = el coturn del appliance (default de fábrica)
--   sbc     = el del SBC-NG; el host sale del enlace y el coturn local se apaga
--   externo = URL y credenciales cargadas a mano
-- El default es `propio` también en las centrales que hoy tienen `TURN_HOST` apuntando a
-- otra máquina: esa variable NUNCA alimentó `/api/ice` (sólo la topología), así que
-- dejarla mandar acá sería consagrar un error que hasta ahora no tenía efecto sobre el
-- medio. El administrador cambia el origen desde el panel, que es el punto: hasta hoy
-- había que entrar por SSH a editar el `.env`.
INSERT INTO pbxng_settings (key, value)
SELECT 'turn_origen', 'propio'
 WHERE NOT EXISTS (SELECT 1 FROM pbxng_settings WHERE key = 'turn_origen')
ON CONFLICT (key) DO NOTHING;

-- Un `stun_url` viejo apuntando a un servicio público se limpia: el default pasa a ser
-- el propio appliance (lo resuelve turn.js). Una central sin salida a internet —lo normal
-- en un organismo público— arrancaba el WebRTC pidiéndole permiso a Google y fallaba.
-- Sólo se borra si es de Google/Cloudflare/Twilio: un STUN propio cargado a mano queda.
DELETE FROM pbxng_settings
 WHERE key = 'stun_url'
   AND value ~* '(stun\.l\.google\.com|stun\.cloudflare\.com|global\.stun\.twilio\.com)';
