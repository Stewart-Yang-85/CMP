-- Phase 34 (extension): Drop redundant denormalized carrier/plan snapshot columns on `public.packages`.
-- `supplier_id`, `operator_id`, `service_type`, `apn` are derived at read time from
-- `carrier_service_modules`, `price_plans`, and `apn_profiles` (via `apn_profile_id`).
--
-- Prerequisite: application deployed that no longer selects/inserts/updates these columns.
--
-- Rollback (manual): re-add nullable columns and backfill from carrier module + price plan + apn_profiles.

BEGIN;

ALTER TABLE public.packages
  DROP COLUMN IF EXISTS supplier_id,
  DROP COLUMN IF EXISTS operator_id,
  DROP COLUMN IF EXISTS service_type,
  DROP COLUMN IF EXISTS apn;

COMMIT;
