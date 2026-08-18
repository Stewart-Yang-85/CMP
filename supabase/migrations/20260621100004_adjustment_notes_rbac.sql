-- RBAC for adjustment note list / approve (Phase 39 PR-B).

INSERT INTO permissions (code, name, description, category) VALUES
  ('bills.adjust.list', 'List Adjustment Notes', 'List credit/debit adjustment notes in tenant scope', 'bills'),
  ('bills.adjust.approve', 'Approve Adjustment Note', 'Approve DRAFT adjustment notes for settlement', 'bills')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'reseller_admin'
  AND p.code IN ('bills.adjust.list', 'bills.adjust.approve')
ON CONFLICT DO NOTHING;
