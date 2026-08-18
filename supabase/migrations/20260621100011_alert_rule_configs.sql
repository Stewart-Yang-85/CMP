-- Phase 43 / T346: US9 alert rule configuration tables.

BEGIN;

CREATE TABLE IF NOT EXISTS alert_rule_configs (
  config_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL,
  reseller_id uuid REFERENCES tenants(tenant_id),
  enterprise_id uuid REFERENCES tenants(tenant_id),
  alert_type alert_type NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  severity alert_severity NOT NULL,
  threshold_value numeric,
  threshold_unit text,
  window_minutes integer,
  suppress_minutes integer NOT NULL DEFAULT 30,
  delivery_channels text[] NOT NULL DEFAULT ARRAY['PORTAL']::text[],
  delivery_targets jsonb NOT NULL DEFAULT '{}'::jsonb,
  threshold_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  CONSTRAINT alert_rule_configs_scope_type_chk
    CHECK (scope_type IN ('PLATFORM', 'RESELLER', 'ENTERPRISE')),
  CONSTRAINT alert_rule_configs_scope_shape_chk
    CHECK (
      (scope_type = 'PLATFORM' AND reseller_id IS NULL AND enterprise_id IS NULL)
      OR (scope_type = 'RESELLER' AND reseller_id IS NOT NULL AND enterprise_id IS NULL)
      OR (scope_type = 'ENTERPRISE' AND reseller_id IS NOT NULL AND enterprise_id IS NOT NULL)
    ),
  CONSTRAINT alert_rule_configs_threshold_unit_chk
    CHECK (
      threshold_unit IS NULL
      OR threshold_unit IN ('PERCENT', 'KB', 'MB', 'GB', 'HOURS', 'MINUTES', 'ATTEMPTS', 'COUNT')
    ),
  CONSTRAINT alert_rule_configs_window_minutes_chk
    CHECK (window_minutes IS NULL OR window_minutes > 0),
  CONSTRAINT alert_rule_configs_suppress_minutes_chk
    CHECK (suppress_minutes >= 0),
  CONSTRAINT alert_rule_configs_delivery_channels_chk
    CHECK (array_length(delivery_channels, 1) IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_rule_configs_platform
  ON alert_rule_configs(alert_type)
  WHERE scope_type = 'PLATFORM';

CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_rule_configs_reseller
  ON alert_rule_configs(reseller_id, alert_type)
  WHERE scope_type = 'RESELLER';

CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_rule_configs_enterprise
  ON alert_rule_configs(reseller_id, enterprise_id, alert_type)
  WHERE scope_type = 'ENTERPRISE';

CREATE INDEX IF NOT EXISTS idx_alert_rule_configs_scope
  ON alert_rule_configs(scope_type, reseller_id, enterprise_id, alert_type);

ALTER TABLE IF EXISTS alert_rule_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alert_rule_configs_no_anon ON alert_rule_configs;
CREATE POLICY alert_rule_configs_no_anon ON alert_rule_configs
  FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS alert_rule_configs_authenticated ON alert_rule_configs;
CREATE POLICY alert_rule_configs_authenticated ON alert_rule_configs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

INSERT INTO alert_rule_configs (
  scope_type,
  alert_type,
  enabled,
  severity,
  threshold_value,
  threshold_unit,
  window_minutes,
  suppress_minutes,
  delivery_channels,
  delivery_targets
)
VALUES
  ('PLATFORM', 'POOL_USAGE_HIGH', true, 'P2', 500000, 'KB', 60, 30, ARRAY['PORTAL']::text[], '{}'::jsonb),
  ('PLATFORM', 'OUT_OF_PROFILE_SURGE', true, 'P2', 20, 'PERCENT', 60, 30, ARRAY['PORTAL']::text[], '{}'::jsonb),
  ('PLATFORM', 'SILENT_SIM', true, 'P3', 4320, 'HOURS', 60, 30, ARRAY['PORTAL']::text[], '{}'::jsonb),
  ('PLATFORM', 'UNEXPECTED_ROAMING', true, 'P1', NULL, NULL, 60, 30, ARRAY['PORTAL']::text[], '{}'::jsonb),
  ('PLATFORM', 'CDR_DELAY', true, 'P1', 48, 'HOURS', 60, 30, ARRAY['PORTAL']::text[], '{}'::jsonb),
  ('PLATFORM', 'UPSTREAM_DISCONNECT', true, 'P1', 3, 'ATTEMPTS', 60, 30, ARRAY['PORTAL']::text[], '{}'::jsonb),
  ('PLATFORM', 'WEBHOOK_DELIVERY_FAILED', true, 'P2', 3, 'ATTEMPTS', 60, 30, ARRAY['PORTAL']::text[], '{}'::jsonb)
ON CONFLICT DO NOTHING;

COMMENT ON TABLE alert_rule_configs IS
  'US9 alert rule configs. Logical PLATFORM/RESELLER/ENTERPRISE configuration tables represented as rows.';

COMMIT;
