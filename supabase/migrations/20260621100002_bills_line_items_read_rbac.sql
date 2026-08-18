-- Restrict SIM-level bill detail (L3 JSON/CSV) to reseller_admin via bills.line_items.read.

INSERT INTO permissions (code, name, description, category) VALUES
  ('bills.line_items.read', 'Read Bill Line Items', 'View SIM-level bill line items (L3) and CSV export', 'bills')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'reseller_admin'
  AND p.code = 'bills.line_items.read'
ON CONFLICT DO NOTHING;
