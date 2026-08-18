-- Add deprecated_at to network profile snapshot tables (aligned with price_plans).

ALTER TABLE public.roaming_profiles
  ADD COLUMN IF NOT EXISTS deprecated_at timestamptz;

ALTER TABLE public.apn_profiles
  ADD COLUMN IF NOT EXISTS deprecated_at timestamptz;

ALTER TABLE public.covered_network_profiles
  ADD COLUMN IF NOT EXISTS deprecated_at timestamptz;

UPDATE public.roaming_profiles
SET deprecated_at = updated_at
WHERE status = 'DEPRECATED' AND deprecated_at IS NULL;

UPDATE public.apn_profiles
SET deprecated_at = updated_at
WHERE status = 'DEPRECATED' AND deprecated_at IS NULL;

UPDATE public.covered_network_profiles
SET deprecated_at = updated_at
WHERE status = 'DEPRECATED' AND deprecated_at IS NULL;
