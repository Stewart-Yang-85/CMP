-- Outbound webhook subscription uniqueness (mirror upstream_integrations):
-- one live row (ACTIVE/INACTIVE) per enterprise; one live reseller-level row per reseller.
-- DELETE soft-deprecates (DEPRECATED) so a new create may reuse the same scope key.

ALTER TABLE webhook_subscriptions
  ADD COLUMN IF NOT EXISTS status text;

UPDATE webhook_subscriptions
SET status = CASE WHEN enabled THEN 'ACTIVE' ELSE 'DEPRECATED' END
WHERE status IS NULL;

ALTER TABLE webhook_subscriptions
  ALTER COLUMN status SET DEFAULT 'ACTIVE';

ALTER TABLE webhook_subscriptions
  ALTER COLUMN status SET NOT NULL;

ALTER TABLE webhook_subscriptions
  DROP CONSTRAINT IF EXISTS webhook_subscriptions_status_check;

ALTER TABLE webhook_subscriptions
  ADD CONSTRAINT webhook_subscriptions_status_check
  CHECK (status IN ('ACTIVE', 'INACTIVE', 'DEPRECATED'));

-- Keep enabled in sync with status for existing live rows marked ACTIVE.
UPDATE webhook_subscriptions SET enabled = true WHERE status = 'ACTIVE' AND enabled IS DISTINCT FROM true;
UPDATE webhook_subscriptions SET enabled = false WHERE status IN ('INACTIVE', 'DEPRECATED') AND enabled IS DISTINCT FROM false;

-- Deduplicate before unique indexes: keep newest live row per scope, deprecate the rest.
WITH ranked_enterprise AS (
  SELECT
    webhook_id,
    ROW_NUMBER() OVER (
      PARTITION BY enterprise_id
      ORDER BY created_at DESC NULLS LAST, webhook_id DESC
    ) AS rn
  FROM webhook_subscriptions
  WHERE enterprise_id IS NOT NULL
    AND status IN ('ACTIVE', 'INACTIVE')
)
UPDATE webhook_subscriptions ws
SET status = 'DEPRECATED',
    enabled = false,
    updated_at = now()
FROM ranked_enterprise r
WHERE ws.webhook_id = r.webhook_id
  AND r.rn > 1;

WITH ranked_reseller AS (
  SELECT
    webhook_id,
    ROW_NUMBER() OVER (
      PARTITION BY reseller_id
      ORDER BY created_at DESC NULLS LAST, webhook_id DESC
    ) AS rn
  FROM webhook_subscriptions
  WHERE enterprise_id IS NULL
    AND reseller_id IS NOT NULL
    AND status IN ('ACTIVE', 'INACTIVE')
)
UPDATE webhook_subscriptions ws
SET status = 'DEPRECATED',
    enabled = false,
    updated_at = now()
FROM ranked_reseller r
WHERE ws.webhook_id = r.webhook_id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_subscriptions_enterprise_live
  ON webhook_subscriptions (enterprise_id)
  WHERE enterprise_id IS NOT NULL
    AND status IN ('ACTIVE', 'INACTIVE');

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_subscriptions_reseller_live
  ON webhook_subscriptions (reseller_id)
  WHERE enterprise_id IS NULL
    AND reseller_id IS NOT NULL
    AND status IN ('ACTIVE', 'INACTIVE');

COMMENT ON COLUMN webhook_subscriptions.status IS
  'ACTIVE | INACTIVE | DEPRECATED — live uniqueness applies to ACTIVE/INACTIVE (Integration-style); DELETE sets DEPRECATED.';
