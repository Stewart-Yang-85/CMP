-- RBAC: permission sims.assign_department (POST /v1/sims:assign-to-department)

BEGIN;

INSERT INTO permissions (code, name, description, category) VALUES
  (
    'sims.assign_department',
    'Assign SIMs to Department',
    'Assign enterprise SIMs to a child department via CSV',
    'sims'
  )
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r,
  permissions p
WHERE r.code = 'customer_admin'
  AND p.code = 'sims.assign_department'
ON CONFLICT DO NOTHING;

COMMIT;
