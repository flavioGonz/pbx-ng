-- 0001 · baseline del versionado de schema.
-- El schema base hoy se autocrea (app.js: CREATE TABLE IF NOT EXISTS + config/initdb).
-- Este archivo solo marca el punto de partida. Los cambios de schema NUEVOS van como
-- 0002_*.sql, 0003_*.sql, ... y NO se editan una vez aplicados (se agrega otro archivo).
SELECT 1;
