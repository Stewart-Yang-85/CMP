-- Rating-derived daily package usage summary for alerts and operating analytics.

BEGIN;

CREATE TABLE IF NOT EXISTS usage_package_daily_summary (
  usage_package_summary_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid REFERENCES suppliers(supplier_id),
  reseller_id uuid REFERENCES tenants(tenant_id),
  enterprise_id uuid REFERENCES tenants(tenant_id),
  sim_id uuid REFERENCES sims(sim_id),
  iccid text,
  usage_day date NOT NULL,
  visited_mccmnc text NOT NULL,
  subscription_id uuid REFERENCES subscriptions(subscription_id),
  package_id uuid REFERENCES packages(package_id),
  price_plan_id uuid REFERENCES price_plans(price_plan_id),
  price_plan_type text,
  in_profile_mb numeric NOT NULL DEFAULT 0,
  out_of_profile_mb numeric NOT NULL DEFAULT 0,
  unclassified_mb numeric NOT NULL DEFAULT 0,
  uplink_mb numeric NOT NULL DEFAULT 0,
  downlink_mb numeric NOT NULL DEFAULT 0,
  total_mb numeric NOT NULL DEFAULT 0,
  amount numeric(12, 2) NOT NULL DEFAULT 0,
  currency text,
  calculation_id text,
  rated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  CONSTRAINT usage_package_daily_summary_nonnegative_chk CHECK (
    in_profile_mb >= 0
    AND out_of_profile_mb >= 0
    AND unclassified_mb >= 0
    AND uplink_mb >= 0
    AND downlink_mb >= 0
    AND total_mb >= 0
    AND amount >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_package_daily_summary_grain
  ON usage_package_daily_summary (
    sim_id,
    usage_day,
    COALESCE(subscription_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(price_plan_id, '00000000-0000-0000-0000-000000000000'::uuid),
    visited_mccmnc
  );

CREATE INDEX IF NOT EXISTS idx_usage_package_daily_enterprise_day
  ON usage_package_daily_summary(enterprise_id, usage_day);

CREATE INDEX IF NOT EXISTS idx_usage_package_daily_package_day
  ON usage_package_daily_summary(package_id, usage_day);

CREATE INDEX IF NOT EXISTS idx_usage_package_daily_sim_day
  ON usage_package_daily_summary(sim_id, usage_day);

ALTER TABLE IF EXISTS usage_package_daily_summary ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS usage_package_daily_summary_no_anon_access ON usage_package_daily_summary;
CREATE POLICY usage_package_daily_summary_no_anon_access
  ON usage_package_daily_summary
  FOR ALL TO anon
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS usage_package_daily_summary_tenant_isolation ON usage_package_daily_summary;
CREATE POLICY usage_package_daily_summary_tenant_isolation
  ON usage_package_daily_summary
  FOR ALL TO authenticated
  USING (is_tenant_accessible(enterprise_id))
  WITH CHECK (is_tenant_accessible(enterprise_id));

COMMIT;
