-- Record when a webhook subscription was deprecated (POST ...:deprecate).

ALTER TABLE webhook_subscriptions
  ADD COLUMN IF NOT EXISTS deprecated_at timestamptz;

-- Backfill existing DEPRECATED rows from updated_at when available.
UPDATE webhook_subscriptions
SET deprecated_at = COALESCE(updated_at, created_at, now())
WHERE status = 'DEPRECATED'
  AND deprecated_at IS NULL;

COMMENT ON COLUMN webhook_subscriptions.deprecated_at IS
  'Set when status becomes DEPRECATED via POST /webhook-subscriptions/{webhookId}:deprecate; null while live.';
