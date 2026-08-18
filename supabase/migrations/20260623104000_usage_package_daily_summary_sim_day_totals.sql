-- Add SIM-day uplink/downlink/total usage fields to rated package summaries.
-- These fields are copied from usage_daily_summary at SIM + usage_day grain and
-- are intentionally not allocated across packages.

BEGIN;

ALTER TABLE usage_package_daily_summary
  ADD COLUMN IF NOT EXISTS uplink_mb numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS downlink_mb numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_mb numeric NOT NULL DEFAULT 0;

WITH sim_day_totals AS (
  SELECT
    sim_id,
    usage_day,
    SUM(COALESCE(uplink_mb, 0)) AS uplink_mb,
    SUM(COALESCE(downlink_mb, 0)) AS downlink_mb,
    SUM(COALESCE(total_mb, 0)) AS total_mb
  FROM usage_daily_summary
  WHERE sim_id IS NOT NULL
  GROUP BY sim_id, usage_day
)
UPDATE usage_package_daily_summary upds
SET
  uplink_mb = sim_day_totals.uplink_mb,
  downlink_mb = sim_day_totals.downlink_mb,
  total_mb = sim_day_totals.total_mb,
  updated_at = current_timestamp
FROM sim_day_totals
WHERE upds.sim_id = sim_day_totals.sim_id
  AND upds.usage_day = sim_day_totals.usage_day;

ALTER TABLE usage_package_daily_summary
  DROP CONSTRAINT IF EXISTS usage_package_daily_summary_nonnegative_chk;

ALTER TABLE usage_package_daily_summary
  ADD CONSTRAINT usage_package_daily_summary_nonnegative_chk CHECK (
    in_profile_mb >= 0
    AND out_of_profile_mb >= 0
    AND unclassified_mb >= 0
    AND uplink_mb >= 0
    AND downlink_mb >= 0
    AND total_mb >= 0
    AND amount >= 0
  );

COMMIT;
