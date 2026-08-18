-- Grant platform_admin sims.mark_test_ready in role_permissions (permission matrix / audit).
-- Runtime: platform_admin still bypasses RBAC in application code (see rbac_seed).

BEGIN;

INSERT INTO roles (code, name, description, scope) VALUES
  (
    'platform_admin',
    'Platform Admin',
    'CMP platform operator; JWT roleScope=platform or role=platform_admin',
    'platform'
  )
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'platform_admin'
  AND p.code = 'sims.mark_test_ready'
ON CONFLICT DO NOTHING;

COMMIT;
