-- La tabla realtime `voicemail` de Asterisk NO trae unicidad por (mailbox, context):
-- se podian crear dos buzones para el mismo interno (uno a mano desde el panel y otro
-- por el auto-buzon) y Asterisk tomaba cualquiera. Deduplicamos y lo prevenimos.

-- 1) dejar una sola fila por (mailbox, context): la que tenga email, y si no, la mas vieja
DELETE FROM voicemail v
 USING voicemail w
 WHERE v.mailbox = w.mailbox AND v.context = w.context
   AND ( (COALESCE(w.email,'') <> '' AND COALESCE(v.email,'') = '')
      OR ( (COALESCE(w.email,'') <> '') = (COALESCE(v.email,'') <> '') AND v.uniqueid > w.uniqueid ) );

-- 2) que no vuelva a pasar
CREATE UNIQUE INDEX IF NOT EXISTS voicemail_mailbox_context_uniq ON voicemail (mailbox, context);
