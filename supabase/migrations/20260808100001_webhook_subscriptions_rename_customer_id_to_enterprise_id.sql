-- Rename webhook_subscriptions.customer_id → enterprise_id (ENTERPRISE tenants.tenant_id).
-- Aligns with jobs / bills / events naming.

ALTER TABLE webhook_subscriptions RENAME COLUMN customer_id TO enterprise_id;

ALTER TABLE webhook_subscriptions DROP CONSTRAINT IF EXISTS webhook_subscriptions_check;
ALTER TABLE webhook_subscriptions DROP CONSTRAINT IF EXISTS webhook_subscriptions_reseller_id_or_customer_id_check;

ALTER TABLE webhook_subscriptions
  ADD CONSTRAINT webhook_subscriptions_scope_check
  CHECK (reseller_id IS NOT NULL OR enterprise_id IS NOT NULL);

-- Backfill reseller_id for enterprise-scoped rows that were created without it.
UPDATE webhook_subscriptions ws
SET reseller_id = t.parent_id
FROM tenants t
WHERE ws.enterprise_id IS NOT NULL
  AND ws.reseller_id IS NULL
  AND t.tenant_id = ws.enterprise_id
  AND t.tenant_type = 'ENTERPRISE'
  AND t.parent_id IS NOT NULL;

COMMENT ON COLUMN webhook_subscriptions.enterprise_id IS
  'ENTERPRISE tenants.tenant_id when subscription is enterprise-scoped; null for reseller-only subscriptions.';
