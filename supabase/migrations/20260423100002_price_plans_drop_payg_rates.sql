-- Price plans: replace payg_rates JSONB with first-class columns; drop embedded meta (commercialTerms, controlPolicy, carrierService, PAYG zones).
-- OOP / zone PAYG live on Package → Carrier → Roaming Profile, not on price_plans.
-- Rollback (lossy): re-add payg_rates jsonb and backfill only expiry/proration from columns if needed.

BEGIN;

ALTER TABLE public.price_plans
  ADD COLUMN IF NOT EXISTS expiry_boundary text,
  ADD COLUMN IF NOT EXISTS proration_rounding text;

-- Backfill from legacy payg_rates.meta (if column still present)
UPDATE public.price_plans
SET
  expiry_boundary = COALESCE(
    NULLIF(btrim(expiry_boundary), ''),
    NULLIF(btrim(payg_rates->'meta'->>'expiryBoundary'), '')
  )
WHERE payg_rates IS NOT NULL;

UPDATE public.price_plans
SET
  proration_rounding = COALESCE(
    NULLIF(btrim(proration_rounding), ''),
    NULLIF(btrim(payg_rates->'meta'->>'prorationRounding'), ''),
    'ROUND_HALF_UP'
  )
WHERE payg_rates IS NOT NULL OR proration_rounding IS NULL;

UPDATE public.price_plans
SET proration_rounding = 'ROUND_HALF_UP'
WHERE proration_rounding IS NULL OR btrim(proration_rounding) = '';

ALTER TABLE public.price_plans DROP COLUMN IF EXISTS payg_rates;

COMMENT ON COLUMN public.price_plans.expiry_boundary IS
  'ONE_TIME: CALENDAR_DAY_END | DURATION_EXCLUSIVE_END (subscription expiry semantics).';
COMMENT ON COLUMN public.price_plans.proration_rounding IS
  'Rounding rule for proration; e.g. ROUND_HALF_UP.';

COMMIT;
