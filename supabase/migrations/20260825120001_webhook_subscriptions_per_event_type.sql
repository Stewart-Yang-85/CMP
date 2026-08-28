-- Scheme A: one live outbound webhook subscription per (tenant scope, event type).
-- Replaces "one live row per enterprise / reseller-level" uniqueness.

-- 1) Drop previous live uniqueness (scope only).
DROP INDEX IF EXISTS uq_webhook_subscriptions_enterprise_live;
DROP INDEX IF EXISTS uq_webhook_subscriptions_reseller_live;

-- 2) Expand multi-type LIVE rows: clone remaining event types onto new rows (same url/secret).
INSERT INTO webhook_subscriptions (
  reseller_id,
  enterprise_id,
  url,
  secret,
  event_types,
  enabled,
  status,
  description,
  deprecated_at
)
SELECT
  m.reseller_id,
  m.enterprise_id,
  m.url,
  m.secret,
  ARRAY[t.event_type]::text[],
  m.enabled,
  m.status,
  m.description,
  m.deprecated_at
FROM webhook_subscriptions m
CROSS JOIN LATERAL unnest(m.event_types) WITH ORDINALITY AS t(event_type, ord)
WHERE m.status IN ('ACTIVE', 'INACTIVE')
  AND cardinality(m.event_types) > 1
  AND t.ord > 1;

-- 3) Shrink every multi-type row to its first event type (live clones already created above).
UPDATE webhook_subscriptions
SET event_types = event_types[1:1],
    updated_at = now()
WHERE cardinality(event_types) > 1;

-- 4) Empty / null event_types cannot participate in uniqueness — deprecate.
UPDATE webhook_subscriptions
SET status = 'DEPRECATED',
    enabled = false,
    deprecated_at = COALESCE(deprecated_at, now()),
    updated_at = now()
WHERE status IN ('ACTIVE', 'INACTIVE')
  AND (event_types IS NULL OR cardinality(event_types) = 0);

-- 5) Deduplicate live rows by (scope, event_types[1]); keep newest.
WITH ranked_enterprise AS (
  SELECT
    webhook_id,
    ROW_NUMBER() OVER (
      PARTITION BY enterprise_id, event_types[1]
      ORDER BY created_at DESC NULLS LAST, webhook_id DESC
    ) AS rn
  FROM webhook_subscriptions
  WHERE enterprise_id IS NOT NULL
    AND status IN ('ACTIVE', 'INACTIVE')
    AND cardinality(event_types) = 1
)
UPDATE webhook_subscriptions ws
SET status = 'DEPRECATED',
    enabled = false,
    deprecated_at = COALESCE(ws.deprecated_at, now()),
    updated_at = now()
FROM ranked_enterprise r
WHERE ws.webhook_id = r.webhook_id
  AND r.rn > 1;

WITH ranked_reseller AS (
  SELECT
    webhook_id,
    ROW_NUMBER() OVER (
      PARTITION BY reseller_id, event_types[1]
      ORDER BY created_at DESC NULLS LAST, webhook_id DESC
    ) AS rn
  FROM webhook_subscriptions
  WHERE enterprise_id IS NULL
    AND reseller_id IS NOT NULL
    AND status IN ('ACTIVE', 'INACTIVE')
    AND cardinality(event_types) = 1
)
UPDATE webhook_subscriptions ws
SET status = 'DEPRECATED',
    enabled = false,
    deprecated_at = COALESCE(ws.deprecated_at, now()),
    updated_at = now()
FROM ranked_reseller r
WHERE ws.webhook_id = r.webhook_id
  AND r.rn > 1;

-- 6) Enforce exactly one event type on all rows going forward.
ALTER TABLE webhook_subscriptions
  DROP CONSTRAINT IF EXISTS webhook_subscriptions_single_event_type;

ALTER TABLE webhook_subscriptions
  ADD CONSTRAINT webhook_subscriptions_single_event_type
  CHECK (cardinality(event_types) = 1);

-- 7) Live uniqueness per scope + event type.
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_subscriptions_enterprise_event_live
  ON webhook_subscriptions (enterprise_id, (event_types[1]))
  WHERE enterprise_id IS NOT NULL
    AND status IN ('ACTIVE', 'INACTIVE');

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_subscriptions_reseller_event_live
  ON webhook_subscriptions (reseller_id, (event_types[1]))
  WHERE enterprise_id IS NULL
    AND reseller_id IS NOT NULL
    AND status IN ('ACTIVE', 'INACTIVE');

COMMENT ON CONSTRAINT webhook_subscriptions_single_event_type ON webhook_subscriptions IS
  'Scheme A: each subscription binds exactly one outbound event type (one URL per event type).';

COMMENT ON INDEX uq_webhook_subscriptions_enterprise_event_live IS
  'At most one ACTIVE/INACTIVE subscription per enterprise_id + event type.';

COMMENT ON INDEX uq_webhook_subscriptions_reseller_event_live IS
  'At most one ACTIVE/INACTIVE reseller-level subscription per reseller_id + event type.';
