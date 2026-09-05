-- 0008 · Roles de panel = los de control-plane/rbac.js (docs/CONTRATOS.md §2).
--
-- Hasta 1.4.0 /usuarios ofrecia 'operator' y 'viewer'. El RBAC nuevo solo conoce
-- admin / supervisor / agente y el login rechaza cualquier otro rol con 403: sin
-- esta conversion, esos usuarios quedaban afuera hasta que un admin los tocara.
-- Mapeo: operator (operaba la central) -> supervisor; viewer (solo miraba) -> agente.
-- El default de la columna era 'admin' (initdb): pasa a 'agente', el menos
-- privilegiado, para que un alta sin rol explicito no cree otro administrador.
UPDATE pbxng_users SET role = 'supervisor' WHERE role = 'operator';
UPDATE pbxng_users SET role = 'agente'     WHERE role = 'viewer';
ALTER TABLE pbxng_users ALTER COLUMN role SET DEFAULT 'agente';
