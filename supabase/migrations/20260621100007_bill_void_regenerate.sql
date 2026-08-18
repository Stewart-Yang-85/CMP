-- Phase 41b: void columns, partial unique (excludes VOIDED), RBAC (runs after enum commit)

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS void_reason text;

ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_enterprise_id_period_start_period_end_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bills_enterprise_period_active
  ON bills (enterprise_id, period_start, period_end)
  WHERE status <> 'VOIDED';

INSERT INTO permissions (code, name, description, category) VALUES
  ('bills.void', 'Void Bill', 'Void GENERATED/PUBLISHED/OVERDUE bill to allow re-generation for the same period', 'bills')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'reseller_admin' AND p.code = 'bills.void'
ON CONFLICT DO NOTHING;
