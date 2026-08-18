-- RBAC: permission sims.assign_inventory (POST /v1/sims:assign-inventory-to-enterprise)
--
-- For databases that already applied 20260324100003_rbac_seed.sql before that seed
-- included this row. Safe to re-run: inserts use ON CONFLICT DO NOTHING.

BEGIN;

INSERT INTO permissions (code, name, description, category) VALUES
  (
    'sims.assign_inventory',
    'Assign Inventory SIMs',
    'Assign reseller pool SIMs to child enterprise',
    'sims'
  )
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r,
  permissions p
WHERE r.code = 'reseller_admin'
  AND p.code = 'sims.assign_inventory'
ON CONFLICT DO NOTHING;

COMMIT;
