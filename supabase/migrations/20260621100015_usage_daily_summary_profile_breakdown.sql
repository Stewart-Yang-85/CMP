-- Add classified usage rollups for cross-module reads (alerts, reports, dashboards).

BEGIN;

ALTER TABLE usage_daily_summary
  ADD COLUMN IF NOT EXISTS in_profile_mb numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS out_of_profile_mb numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unclassified_mb numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rated_at timestamptz;

ALTER TABLE usage_daily_summary
  DROP CONSTRAINT IF EXISTS usage_daily_summary_profile_breakdown_nonnegative_chk;

ALTER TABLE usage_daily_summary
  ADD CONSTRAINT usage_daily_summary_profile_breakdown_nonnegative_chk
  CHECK (
    in_profile_mb >= 0
    AND out_of_profile_mb >= 0
    AND unclassified_mb >= 0
  );

CREATE INDEX IF NOT EXISTS idx_usage_daily_summary_profile_breakdown
  ON usage_daily_summary(enterprise_id, usage_day, in_profile_mb, out_of_profile_mb);

COMMIT;
