-- Phase 43 / T352: alert delivery tracking.

BEGIN;

CREATE TABLE IF NOT EXISTS alert_deliveries (
  delivery_id bigserial PRIMARY KEY,
  alert_id uuid NOT NULL REFERENCES alerts(alert_id) ON DELETE CASCADE,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  target text,
  event_id uuid REFERENCES events(event_id),
  webhook_delivery_id bigint REFERENCES webhook_deliveries(delivery_id),
  error_code text,
  error_message text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  CONSTRAINT alert_deliveries_channel_chk
    CHECK (channel IN ('PORTAL', 'EMAIL', 'WEBHOOK')),
  CONSTRAINT alert_deliveries_status_chk
    CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED', 'SKIPPED', 'NOT_IMPLEMENTED'))
);

CREATE INDEX IF NOT EXISTS idx_alert_deliveries_alert
  ON alert_deliveries(alert_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alert_deliveries_status
  ON alert_deliveries(status, channel, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alert_deliveries_webhook_delivery
  ON alert_deliveries(webhook_delivery_id)
  WHERE webhook_delivery_id IS NOT NULL;

ALTER TABLE IF EXISTS alert_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alert_deliveries_no_anon ON alert_deliveries;
CREATE POLICY alert_deliveries_no_anon ON alert_deliveries
  FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS alert_deliveries_authenticated ON alert_deliveries;
CREATE POLICY alert_deliveries_authenticated ON alert_deliveries
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMENT ON TABLE alert_deliveries IS
  'Alert delivery tracking for Portal/Email/Webhook channel orchestration.';

COMMIT;
