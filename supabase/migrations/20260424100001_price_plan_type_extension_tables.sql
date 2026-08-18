-- Phase 31: Split type-specific pricing columns from price_plans into four 1:1 child tables.
-- Read model for batching/billing: public.price_plans_expanded (flattened view).
--
-- Rollback (manual, lossy — run only on a branch/clone DB):
--   DROP VIEW IF EXISTS public.price_plans_expanded;
--   ALTER TABLE public.price_plans ADD COLUMN IF NOT EXISTS monthly_fee numeric(12,2) NOT NULL DEFAULT 0;
--   ... (re-add each dropped column with defaults);
--   UPDATE price_plans pp SET monthly_fee = COALESCE(fb.monthly_fee, sdb.monthly_fee, tv.monthly_fee, 0)
--     FROM ... (copy back from child tables before DROP);
--   DROP TABLE IF EXISTS public.price_plan_tiered_volume_pricing, public.price_plan_one_time,
--     public.price_plan_sim_dependent_bundle, public.price_plan_fixed_bundle CASCADE;
-- Or: restore from pre-migration backup.
--
-- Orphan child rows: prevented by PK/FK (child PK = price_plan_id REFERENCES price_plans ON DELETE CASCADE).
-- API uses service role + application inserts parent then child in one request path.

BEGIN;

CREATE TABLE IF NOT EXISTS public.price_plan_fixed_bundle (
  price_plan_id uuid PRIMARY KEY REFERENCES public.price_plans (price_plan_id) ON DELETE CASCADE,
  monthly_fee numeric(12, 2) NOT NULL DEFAULT 0,
  deactivated_monthly_fee numeric(12, 2) NOT NULL DEFAULT 0,
  total_quota_mb bigint,
  overage_rate_per_mb numeric(18, 8)
);

CREATE TABLE IF NOT EXISTS public.price_plan_sim_dependent_bundle (
  price_plan_id uuid PRIMARY KEY REFERENCES public.price_plans (price_plan_id) ON DELETE CASCADE,
  monthly_fee numeric(12, 2) NOT NULL DEFAULT 0,
  deactivated_monthly_fee numeric(12, 2) NOT NULL DEFAULT 0,
  per_sim_quota_mb bigint,
  overage_rate_per_mb numeric(18, 8)
);

CREATE TABLE IF NOT EXISTS public.price_plan_one_time (
  price_plan_id uuid PRIMARY KEY REFERENCES public.price_plans (price_plan_id) ON DELETE CASCADE,
  one_time_fee numeric(12, 2) NOT NULL DEFAULT 0,
  quota_mb bigint NOT NULL DEFAULT 0,
  validity_days int NOT NULL DEFAULT 1,
  expiry_boundary text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.price_plan_tiered_volume_pricing (
  price_plan_id uuid PRIMARY KEY REFERENCES public.price_plans (price_plan_id) ON DELETE CASCADE,
  monthly_fee numeric(12, 2) NOT NULL DEFAULT 0,
  deactivated_monthly_fee numeric(12, 2) NOT NULL DEFAULT 0,
  tiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  overage_rate_per_mb numeric(18, 8)
);

COMMENT ON TABLE public.price_plan_fixed_bundle IS 'FIXED_BUNDLE pricing extension (1:1 price_plans).';
COMMENT ON TABLE public.price_plan_sim_dependent_bundle IS 'SIM_DEPENDENT_BUNDLE pricing extension (1:1 price_plans).';
COMMENT ON TABLE public.price_plan_one_time IS 'ONE_TIME pricing extension (1:1 price_plans).';
COMMENT ON TABLE public.price_plan_tiered_volume_pricing IS 'TIERED_VOLUME_PRICING extension (1:1 price_plans).';

INSERT INTO public.price_plan_fixed_bundle (
  price_plan_id, monthly_fee, deactivated_monthly_fee, total_quota_mb, overage_rate_per_mb
)
SELECT price_plan_id, monthly_fee, deactivated_monthly_fee, total_quota_mb, overage_rate_per_mb
FROM public.price_plans
WHERE type = 'FIXED_BUNDLE';

INSERT INTO public.price_plan_sim_dependent_bundle (
  price_plan_id, monthly_fee, deactivated_monthly_fee, per_sim_quota_mb, overage_rate_per_mb
)
SELECT price_plan_id, monthly_fee, deactivated_monthly_fee, per_sim_quota_mb, overage_rate_per_mb
FROM public.price_plans
WHERE type = 'SIM_DEPENDENT_BUNDLE';

INSERT INTO public.price_plan_one_time (
  price_plan_id, one_time_fee, quota_mb, validity_days, expiry_boundary
)
SELECT
  price_plan_id,
  COALESCE(one_time_fee, 0),
  COALESCE(quota_mb, 0),
  COALESCE(validity_days, 1),
  COALESCE(NULLIF(btrim(expiry_boundary), ''), 'CALENDAR_DAY_END')
FROM public.price_plans
WHERE type = 'ONE_TIME';

INSERT INTO public.price_plan_tiered_volume_pricing (
  price_plan_id, monthly_fee, deactivated_monthly_fee, tiers, overage_rate_per_mb
)
SELECT price_plan_id, monthly_fee, deactivated_monthly_fee, COALESCE(tiers, '[]'::jsonb), overage_rate_per_mb
FROM public.price_plans
WHERE type = 'TIERED_VOLUME_PRICING';

ALTER TABLE public.price_plans
  DROP COLUMN IF EXISTS monthly_fee,
  DROP COLUMN IF EXISTS deactivated_monthly_fee,
  DROP COLUMN IF EXISTS one_time_fee,
  DROP COLUMN IF EXISTS quota_mb,
  DROP COLUMN IF EXISTS validity_days,
  DROP COLUMN IF EXISTS per_sim_quota_mb,
  DROP COLUMN IF EXISTS total_quota_mb,
  DROP COLUMN IF EXISTS overage_rate_per_mb,
  DROP COLUMN IF EXISTS tiers,
  DROP COLUMN IF EXISTS expiry_boundary;

CREATE OR REPLACE VIEW public.price_plans_expanded AS
SELECT
  pp.price_plan_id,
  pp.enterprise_id,
  pp.reseller_id,
  pp.name,
  pp.type,
  pp.service_type,
  pp.currency,
  pp.billing_cycle_type,
  pp.first_cycle_proration,
  pp.proration_rounding,
  pp.source_price_plan_id,
  pp.version,
  pp.status,
  pp.effective_from,
  pp.deprecated_at,
  pp.covered_network_profile_id,
  pp.created_at,
  COALESCE(fb.monthly_fee, sdb.monthly_fee, tv.monthly_fee, 0::numeric(12, 2)) AS monthly_fee,
  COALESCE(fb.deactivated_monthly_fee, sdb.deactivated_monthly_fee, tv.deactivated_monthly_fee, 0::numeric(12, 2)) AS deactivated_monthly_fee,
  ot.one_time_fee,
  ot.quota_mb,
  ot.validity_days,
  sdb.per_sim_quota_mb,
  fb.total_quota_mb,
  COALESCE(fb.overage_rate_per_mb, sdb.overage_rate_per_mb, tv.overage_rate_per_mb) AS overage_rate_per_mb,
  tv.tiers,
  ot.expiry_boundary
FROM public.price_plans pp
LEFT JOIN public.price_plan_fixed_bundle fb ON fb.price_plan_id = pp.price_plan_id
LEFT JOIN public.price_plan_sim_dependent_bundle sdb ON sdb.price_plan_id = pp.price_plan_id
LEFT JOIN public.price_plan_one_time ot ON ot.price_plan_id = pp.price_plan_id
LEFT JOIN public.price_plan_tiered_volume_pricing tv ON tv.price_plan_id = pp.price_plan_id;

COMMENT ON VIEW public.price_plans_expanded IS 'Flattened price plan + type extension tables for billing and read paths.';

GRANT SELECT ON public.price_plans_expanded TO anon, authenticated, service_role;

COMMIT;
