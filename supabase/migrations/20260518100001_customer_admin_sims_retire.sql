-- Grant customer_admin SIM retire (lifecycle); activate/deactivate/reactivate already seeded.

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'customer_admin'
  AND p.code = 'sims.retire'
ON CONFLICT DO NOTHING;
