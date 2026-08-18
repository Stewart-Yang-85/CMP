-- RBAC: permission sims.update (PATCH /v1/sims/:simId — status transitions + remark)
--
-- resolvePermissionForRequest maps PATCH /sims/:id to sims.update. The code default list
-- includes it, but JWT users get DB-backed role_permissions which did not define this code.

BEGIN;

INSERT INTO permissions (code, name, description, category) VALUES
  (
    'sims.update',
    'Update SIM',
    'PATCH SIM (lifecycle status, remark, and other permitted fields)',
    'sims'
  )
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r,
  permissions p
WHERE r.code IN (
    'reseller_admin',
    'reseller_sales_director',
    'reseller_sales',
    'customer_admin'
  )
  AND p.code = 'sims.update'
ON CONFLICT DO NOTHING;

COMMIT;
