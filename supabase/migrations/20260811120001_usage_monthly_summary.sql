-- Natural-month usage snapshot (rollup from usage_daily_summary).
-- Grain: SIM + calendar month + visited_mccmnc. Not package/quota accounting.

BEGIN;

CREATE TABLE IF NOT EXISTS usage_monthly_summary (
  usage_month_id bigserial PRIMARY KEY,
  supplier_id uuid NOT NULL REFERENCES suppliers(supplier_id),
  enterprise_id uuid REFERENCES tenants(tenant_id),
  sim_id uuid REFERENCES sims(sim_id),
  iccid text NOT NULL,
  -- First day of the calendar month (UTC), e.g. 2026-07-01
  usage_month date NOT NULL,
  visited_mccmnc text NOT NULL,
  uplink_mb numeric NOT NULL DEFAULT 0,
  downlink_mb numeric NOT NULL DEFAULT 0,
  total_mb numeric NOT NULL DEFAULT 0,
  in_profile_mb numeric NOT NULL DEFAULT 0,
  out_of_profile_mb numeric NOT NULL DEFAULT 0,
  unclassified_mb numeric NOT NULL DEFAULT 0,
  rated_at timestamptz,
  rolled_up_at timestamptz NOT NULL DEFAULT now(),
  input_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_monthly_summary_iccid_month_visited_key UNIQUE (iccid, usage_month, visited_mccmnc),
  CONSTRAINT usage_monthly_summary_month_is_first_day_chk
    CHECK (usage_month = (date_trunc('month', usage_month::timestamp))::date),
  CONSTRAINT usage_monthly_summary_mb_nonnegative_chk
    CHECK (
      uplink_mb >= 0
      AND downlink_mb >= 0
      AND total_mb >= 0
      AND in_profile_mb >= 0
      AND out_of_profile_mb >= 0
      AND unclassified_mb >= 0
    )
);

CREATE INDEX IF NOT EXISTS idx_usage_monthly_enterprise_month
  ON usage_monthly_summary (enterprise_id, usage_month);

CREATE INDEX IF NOT EXISTS idx_usage_monthly_sim_month
  ON usage_monthly_summary (sim_id, usage_month);

CREATE INDEX IF NOT EXISTS idx_usage_monthly_month
  ON usage_monthly_summary (usage_month);

COMMENT ON TABLE usage_monthly_summary IS
  'Calendar-month usage snapshot rolled up from usage_daily_summary (SIM × month × visited_mccmnc). Independent of package quota / ONE_TIME periods and billing generate.';

COMMIT;
