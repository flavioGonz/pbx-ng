-- PBX-NG · RFC 5626 (SIP Outbound) para las extensiones ya existentes.
--
-- Por que hace falta:
--
--   support_path (RFC 3327)  Sin Path, cuando un telefono se registra a traves de un
--                            borde (SBC) la central no guarda la ruta de vuelta y las
--                            llamadas hacia ese interno no encuentran el camino.
--
--   remove_existing='no'     Estaba en 'yes': cada REGISTER nuevo borraba el contacto
--                            anterior. Eso es exactamente lo contrario de lo que busca
--                            5626, que es que un mismo interno sostenga varios flujos a
--                            la vez (por ejemplo el celular por wifi y por datos, o dos
--                            bordes en paralelo) para no perder llamadas si uno se cae.
--
--   remove_unavailable='yes' El contrapeso: al llegar al tope de max_contacts, Asterisk
--                            descarta primero los contactos que no responden al qualify,
--                            en vez de acumular registros muertos que hacen sonar la
--                            nada. Sin esto, sacar remove_existing dejaria telefonos
--                            fantasma.
--
-- Solo toca AoRs de extension. Las troncales quedan como estan (max_contacts=1, un
-- unico destino conocido: 5626 no aplica).

UPDATE ps_aors a
   SET support_path        = 'yes',
       remove_existing     = 'no',
       remove_unavailable  = 'yes'
  FROM ps_endpoints e
 WHERE e.id = a.id
   AND COALESCE(e.pbxng_kind, 'extension') = 'extension'
   AND (a.support_path IS DISTINCT FROM 'yes'
     OR a.remove_existing IS DISTINCT FROM 'no'
     OR a.remove_unavailable IS DISTINCT FROM 'yes');

-- Un AoR sin qualify no detecta contactos caidos, y sin eso remove_unavailable no tiene
-- de donde agarrarse. Le damos 60s a los que quedaron en 0 o en NULL.
UPDATE ps_aors a
   SET qualify_frequency = 60
  FROM ps_endpoints e
 WHERE e.id = a.id
   AND COALESCE(e.pbxng_kind, 'extension') = 'extension'
   AND COALESCE(a.qualify_frequency, 0) = 0;
