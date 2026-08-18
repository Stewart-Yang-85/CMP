-- Phase 34 (T254): Drop denormalized module JSON from `public.packages`.
-- Prerequisites:
--   1) Application deployed that reads/writes packages via FKs only (T255).
--   2) Optional: verify rows — module snapshots match former JSON (spot-check / hash) before DROP.
-- Rollback (manual): re-add nullable columns; data is NOT restored automatically.
--   ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS commercial_terms jsonb;
--   ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS control_policy jsonb;
--   ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS carrier_service_config jsonb;
--   ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS roaming_profile jsonb;

ALTER TABLE public.packages
  DROP COLUMN IF EXISTS commercial_terms,
  DROP COLUMN IF EXISTS control_policy,
  DROP COLUMN IF EXISTS carrier_service_config,
  DROP COLUMN IF EXISTS roaming_profile;
