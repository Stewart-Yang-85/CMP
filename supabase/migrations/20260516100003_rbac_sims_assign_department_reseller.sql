-- Grant sims.assign_department to reseller_admin (customer_admin already in 20260516100002).
-- platform_admin bypasses RBAC permission checks in application code.

BEGIN;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r,
  permissions p
WHERE r.code = 'reseller_admin'
  AND p.code = 'sims.assign_department'
ON CONFLICT DO NOTHING;

COMMIT;
