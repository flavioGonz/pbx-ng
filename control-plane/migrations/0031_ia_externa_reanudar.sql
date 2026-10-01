-- PBX-NG · 0031 · IA EXTERNA, CONTRATO V2: la ventana para reabrir el relay.
--
-- POR QUÉ: con el contrato v2 (docs/CONTRATOS.md §11) el backend del asistente corre en
-- varias instancias, y si la que conduce una llamada se cae o se apaga, la central reabre
-- el relay de esa llamada para que otra la retome. Cuánto lo intenta lo publica el backend
-- en su configuración (`resumeWindowMs`), y se guarda con el resto de la configuración
-- bajada, así un reinicio de la API no lo pierde.
--
-- QUÉ TOCA: una columna nueva, con el valor por defecto del contrato (20 s). Idempotente.
ALTER TABLE pbxng_ia_externa_config ADD COLUMN IF NOT EXISTS resume_window_ms int NOT NULL DEFAULT 20000;
