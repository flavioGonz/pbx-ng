-- Buzon -> Email: opciones por buzon + registro de lo ya enviado (idempotencia).
ALTER TABLE pbxng_mailboxes ADD COLUMN IF NOT EXISTS email_enabled    boolean NOT NULL DEFAULT true;
ALTER TABLE pbxng_mailboxes ADD COLUMN IF NOT EXISTS email_attach     boolean NOT NULL DEFAULT true;   -- adjuntar el WAV
ALTER TABLE pbxng_mailboxes ADD COLUMN IF NOT EXISTS email_transcribe boolean NOT NULL DEFAULT true;   -- transcribir con Whisper
ALTER TABLE pbxng_mailboxes ADD COLUMN IF NOT EXISTS email_delete     boolean NOT NULL DEFAULT false;  -- borrar del buzon tras enviar

CREATE TABLE IF NOT EXISTS pbxng_vm_sent (
  mailbox   text NOT NULL,
  mid       text NOT NULL,
  folder    text NOT NULL DEFAULT 'INBOX',
  origtime  bigint,
  to_addr   text,
  ok        boolean NOT NULL DEFAULT true,
  err       text,
  sent_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox, mid)
);
CREATE INDEX IF NOT EXISTS pbxng_vm_sent_ts ON pbxng_vm_sent (sent_at DESC);
