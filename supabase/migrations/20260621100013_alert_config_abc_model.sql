-- Phase 44 / T358: Alert Configurations ABC model.

BEGIN;

CREATE TABLE IF NOT EXISTS alert_type_catalog (
  alert_type alert_type PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  allowed_scope_types text[] NOT NULL,
  default_severity alert_severity NOT NULL,
  default_threshold_value numeric,
  default_threshold_unit text,
  default_window_minutes int,
  default_suppress_minutes int NOT NULL DEFAULT 30,
  default_delivery_channels text[] NOT NULL DEFAULT ARRAY['PORTAL']::text[],
  default_delivery_targets jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_threshold_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  display_name text NOT NULL,
  description text,
  sort_order int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  CONSTRAINT alert_type_catalog_allowed_scope_chk
    CHECK (allowed_scope_types <@ ARRAY['PLATFORM','RESELLER','ENTERPRISE']::text[]),
  CONSTRAINT alert_type_catalog_threshold_unit_chk
    CHECK (default_threshold_unit IS NULL OR default_threshold_unit IN ('PERCENT', 'KB', 'MB', 'GB', 'HOURS', 'MINUTES', 'ATTEMPTS', 'COUNT')),
  CONSTRAINT alert_type_catalog_window_chk
    CHECK (default_window_minutes IS NULL OR default_window_minutes > 0),
  CONSTRAINT alert_type_catalog_suppress_chk
    CHECK (default_suppress_minutes >= 0),
  CONSTRAINT alert_type_catalog_delivery_channels_chk
    CHECK (default_delivery_channels <@ ARRAY['PORTAL','EMAIL','WEBHOOK']::text[])
);

CREATE TABLE IF NOT EXISTS alert_config_profiles (
  config_profile_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL,
  reseller_id uuid REFERENCES tenants(tenant_id),
  enterprise_id uuid REFERENCES tenants(tenant_id),
  status text NOT NULL DEFAULT 'ACTIVE',
  name text,
  description text,
  version int NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(user_id),
  updated_by uuid REFERENCES users(user_id),
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  CONSTRAINT alert_config_profiles_scope_chk
    CHECK (scope_type IN ('PLATFORM', 'RESELLER', 'ENTERPRISE')),
  CONSTRAINT alert_config_profiles_scope_columns_chk
    CHECK (
      (scope_type = 'PLATFORM' AND reseller_id IS NULL AND enterprise_id IS NULL)
      OR (scope_type = 'RESELLER' AND reseller_id IS NOT NULL AND enterprise_id IS NULL)
      OR (scope_type = 'ENTERPRISE' AND reseller_id IS NOT NULL AND enterprise_id IS NOT NULL)
    ),
  CONSTRAINT alert_config_profiles_status_chk
    CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_config_profiles_platform_active
  ON alert_config_profiles ((status))
  WHERE scope_type = 'PLATFORM' AND status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_config_profiles_reseller_active
  ON alert_config_profiles (reseller_id)
  WHERE scope_type = 'RESELLER' AND status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_config_profiles_enterprise_active
  ON alert_config_profiles (enterprise_id)
  WHERE scope_type = 'ENTERPRISE' AND status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_alert_config_profiles_scope
  ON alert_config_profiles(scope_type, reseller_id, enterprise_id, status);

CREATE TABLE IF NOT EXISTS alert_config_items (
  config_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_profile_id uuid NOT NULL REFERENCES alert_config_profiles(config_profile_id) ON DELETE CASCADE,
  alert_type alert_type NOT NULL REFERENCES alert_type_catalog(alert_type),
  enabled boolean NOT NULL DEFAULT true,
  severity alert_severity NOT NULL,
  threshold_value numeric,
  threshold_unit text,
  window_minutes int,
  suppress_minutes int NOT NULL DEFAULT 30,
  delivery_channels text[] NOT NULL DEFAULT ARRAY['PORTAL']::text[],
  delivery_targets jsonb NOT NULL DEFAULT '{}'::jsonb,
  threshold_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  UNIQUE (config_profile_id, alert_type),
  CONSTRAINT alert_config_items_threshold_unit_chk
    CHECK (threshold_unit IS NULL OR threshold_unit IN ('PERCENT', 'KB', 'MB', 'GB', 'HOURS', 'MINUTES', 'ATTEMPTS', 'COUNT')),
  CONSTRAINT alert_config_items_window_chk
    CHECK (window_minutes IS NULL OR window_minutes > 0),
  CONSTRAINT alert_config_items_suppress_chk
    CHECK (suppress_minutes >= 0),
  CONSTRAINT alert_config_items_delivery_channels_chk
    CHECK (delivery_channels <@ ARRAY['PORTAL','EMAIL','WEBHOOK']::text[])
);

CREATE INDEX IF NOT EXISTS idx_alert_config_items_type
  ON alert_config_items(alert_type, config_profile_id);

INSERT INTO alert_type_catalog (
  alert_type,
  allowed_scope_types,
  default_severity,
  default_threshold_value,
  default_threshold_unit,
  default_window_minutes,
  default_suppress_minutes,
  default_delivery_channels,
  display_name,
  description,
  sort_order
)
VALUES
  ('POOL_USAGE_HIGH', ARRAY['PLATFORM','RESELLER','ENTERPRISE']::text[], 'P2', 500000, 'KB', 60, 30, ARRAY['PORTAL']::text[], 'Pool usage high', 'Enterprise or pool usage exceeded configured threshold.', 10),
  ('OUT_OF_PROFILE_SURGE', ARRAY['PLATFORM','RESELLER','ENTERPRISE']::text[], 'P2', 20, 'PERCENT', 60, 30, ARRAY['PORTAL']::text[], 'Out-of-profile usage surge', 'Package out-of-profile usage consumed the configured percentage of the applicable quota.', 20),
  ('SILENT_SIM', ARRAY['PLATFORM','RESELLER','ENTERPRISE']::text[], 'P3', 4320, 'HOURS', 60, 30, ARRAY['PORTAL']::text[], 'Silent SIM', 'SIM has remained DEACTIVATED beyond the configured threshold.', 30),
  ('UNEXPECTED_ROAMING', ARRAY['PLATFORM','RESELLER','ENTERPRISE']::text[], 'P1', NULL, NULL, 60, 30, ARRAY['PORTAL']::text[], 'Unexpected roaming', 'SIM has out-of-profile roaming usage in the current billing period.', 40),
  ('CDR_DELAY', ARRAY['PLATFORM','RESELLER']::text[], 'P1', 48, 'HOURS', 60, 30, ARRAY['PORTAL']::text[], 'CDR delay', 'CDR files for a reseller integration are delayed beyond the configured threshold.', 50),
  ('UPSTREAM_DISCONNECT', ARRAY['PLATFORM','RESELLER']::text[], 'P1', 3, 'ATTEMPTS', 60, 30, ARRAY['PORTAL']::text[], 'Upstream disconnect', 'Upstream supplier API token probe failed repeatedly for a reseller integration.', 60),
  ('WEBHOOK_DELIVERY_FAILED', ARRAY['PLATFORM','RESELLER']::text[], 'P2', 3, 'ATTEMPTS', 60, 30, ARRAY['PORTAL','WEBHOOK']::text[], 'Webhook delivery failed', 'Outbound webhook delivery exhausted retry attempts.', 70)
ON CONFLICT (alert_type) DO UPDATE SET
  allowed_scope_types = EXCLUDED.allowed_scope_types,
  default_severity = EXCLUDED.default_severity,
  default_threshold_value = EXCLUDED.default_threshold_value,
  default_threshold_unit = EXCLUDED.default_threshold_unit,
  default_window_minutes = EXCLUDED.default_window_minutes,
  default_suppress_minutes = EXCLUDED.default_suppress_minutes,
  default_delivery_channels = EXCLUDED.default_delivery_channels,
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  updated_at = current_timestamp;

INSERT INTO alert_config_profiles (scope_type, status, name, description)
SELECT 'PLATFORM', 'ACTIVE', 'Platform default alert configuration', 'Seeded platform default alert configuration profile.'
WHERE NOT EXISTS (
  SELECT 1 FROM alert_config_profiles
  WHERE scope_type = 'PLATFORM' AND status = 'ACTIVE'
);

INSERT INTO alert_config_items (
  config_profile_id,
  alert_type,
  enabled,
  severity,
  threshold_value,
  threshold_unit,
  window_minutes,
  suppress_minutes,
  delivery_channels,
  delivery_targets,
  threshold_config
)
SELECT
  p.config_profile_id,
  c.alert_type,
  c.enabled,
  c.default_severity,
  c.default_threshold_value,
  c.default_threshold_unit,
  c.default_window_minutes,
  c.default_suppress_minutes,
  c.default_delivery_channels,
  c.default_delivery_targets,
  c.default_threshold_config
FROM alert_config_profiles p
CROSS JOIN alert_type_catalog c
WHERE p.scope_type = 'PLATFORM' AND p.status = 'ACTIVE'
ON CONFLICT (config_profile_id, alert_type) DO NOTHING;

-- Best-effort migration from Phase 43 single-row rule configs into ABC profile/items.
DO $$
DECLARE
  source_exists boolean;
BEGIN
  SELECT to_regclass('public.alert_rule_configs') IS NOT NULL INTO source_exists;
  IF source_exists THEN
    INSERT INTO alert_config_profiles (scope_type, reseller_id, enterprise_id, status, name, description, version, created_at, updated_at)
    SELECT DISTINCT
      scope_type,
      reseller_id,
      enterprise_id,
      'ACTIVE',
      concat(scope_type, ' alert configuration'),
      'Migrated from alert_rule_configs.',
      1,
      min(created_at),
      max(updated_at)
    FROM alert_rule_configs
    WHERE scope_type IN ('RESELLER', 'ENTERPRISE')
    GROUP BY scope_type, reseller_id, enterprise_id
    ON CONFLICT DO NOTHING;

    INSERT INTO alert_config_items (
      config_profile_id,
      alert_type,
      enabled,
      severity,
      threshold_value,
      threshold_unit,
      window_minutes,
      suppress_minutes,
      delivery_channels,
      delivery_targets,
      threshold_config,
      version,
      created_at,
      updated_at
    )
    SELECT
      p.config_profile_id,
      r.alert_type,
      r.enabled,
      r.severity,
      r.threshold_value,
      r.threshold_unit,
      r.window_minutes,
      r.suppress_minutes,
      r.delivery_channels,
      r.delivery_targets,
      r.threshold_config,
      r.version,
      r.created_at,
      r.updated_at
    FROM alert_rule_configs r
    JOIN alert_config_profiles p
      ON p.scope_type = r.scope_type
     AND coalesce(p.reseller_id::text, '') = coalesce(r.reseller_id::text, '')
     AND coalesce(p.enterprise_id::text, '') = coalesce(r.enterprise_id::text, '')
     AND p.status = 'ACTIVE'
    WHERE r.scope_type IN ('RESELLER', 'ENTERPRISE')
    ON CONFLICT (config_profile_id, alert_type) DO NOTHING;
  END IF;
END $$;

ALTER TABLE IF EXISTS alert_type_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS alert_config_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS alert_config_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alert_type_catalog_no_anon ON alert_type_catalog;
CREATE POLICY alert_type_catalog_no_anon ON alert_type_catalog
  FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS alert_type_catalog_authenticated ON alert_type_catalog;
CREATE POLICY alert_type_catalog_authenticated ON alert_type_catalog
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS alert_config_profiles_no_anon ON alert_config_profiles;
CREATE POLICY alert_config_profiles_no_anon ON alert_config_profiles
  FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS alert_config_profiles_authenticated ON alert_config_profiles;
CREATE POLICY alert_config_profiles_authenticated ON alert_config_profiles
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS alert_config_items_no_anon ON alert_config_items;
CREATE POLICY alert_config_items_no_anon ON alert_config_items
  FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS alert_config_items_authenticated ON alert_config_items;
CREATE POLICY alert_config_items_authenticated ON alert_config_items
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMENT ON TABLE alert_type_catalog IS 'Canonical alert type catalog and default configuration metadata.';
COMMENT ON TABLE alert_config_profiles IS 'Alert configuration profile object for PLATFORM, RESELLER, or ENTERPRISE scope.';
COMMENT ON TABLE alert_config_items IS 'Alert rule configuration items under an alert configuration profile.';

COMMIT;
