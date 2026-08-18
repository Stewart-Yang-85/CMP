-- Phase 38 T308: inbound webhook event catalog + per-integration subscriptions

CREATE TABLE IF NOT EXISTS upstream_inbound_webhook_events (
  event_key text PRIMARY KEY,
  display_name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DEPRECATED')),
  sort_order int,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS upstream_integration_webhook_subscriptions (
  integration_id uuid NOT NULL REFERENCES upstream_integrations(integration_id) ON DELETE CASCADE,
  event_key text NOT NULL REFERENCES upstream_inbound_webhook_events(event_key),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_upstream_integration_webhook_subs_integration
  ON upstream_integration_webhook_subscriptions(integration_id);

CREATE INDEX IF NOT EXISTS idx_upstream_integration_webhook_subs_enabled
  ON upstream_integration_webhook_subscriptions(integration_id, event_key)
  WHERE enabled = true;

INSERT INTO upstream_inbound_webhook_events (event_key, display_name, description, sort_order)
VALUES
  ('subscription', 'Subscription', 'Upstream subscription / add-on notification (upstream may send ProductChange)', 10),
  ('update-location', 'Update Location', 'SIM update location (first attach phase; upstream may send SIM_ONLINE or LocationUpdate)', 20),
  ('sim-status-changed', 'SIM status changed', 'SIM lifecycle status changed upstream', 30),
  ('traffic-alert', 'Traffic alert', 'Usage threshold or balance alert', 40)
ON CONFLICT (event_key) DO NOTHING;

COMMENT ON TABLE upstream_inbound_webhook_events IS 'Platform catalog of inbound supplier webhook event_key values';
COMMENT ON TABLE upstream_integration_webhook_subscriptions IS 'Per-integration enablement of inbound webhook events; default none until admin enables';
