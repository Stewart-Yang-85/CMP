-- T281: INVENTORY→TEST_READY permission; tighten sims.retire to reseller_admin only.

BEGIN;

INSERT INTO permissions (code, name, description, category) VALUES
  ('sims.mark_test_ready', 'Mark SIM Test Ready', 'Local INVENTORY to TEST_READY (no upstream)', 'sims')
ON CONFLICT (code) DO NOTHING;

DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND p.code = 'sims.retire'
  AND r.code IN ('customer_admin', 'reseller_sales', 'reseller_sales_director');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'reseller_admin'
  AND p.code = 'sims.mark_test_ready'
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_sim_mark_test_ready_idempotency_key
  ON jobs (idempotency_key)
  WHERE job_type = 'SIM_MARK_TEST_READY'
    AND idempotency_key IS NOT NULL;

COMMIT;
