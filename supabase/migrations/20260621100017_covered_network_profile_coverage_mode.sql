-- Phase 45 T369: explicit CoveredNetworkProfile coverage mode.
-- LIST keeps the historical allowlist semantics; NONE intentionally covers no MCC/MNC
-- and is used by Default Fallback Package profiles.

BEGIN;

ALTER TABLE public.covered_network_profiles
  ADD COLUMN IF NOT EXISTS coverage_mode text NOT NULL DEFAULT 'LIST';

ALTER TABLE public.covered_network_profiles
  DROP CONSTRAINT IF EXISTS covered_network_profiles_coverage_mode_check;

ALTER TABLE public.covered_network_profiles
  ADD CONSTRAINT covered_network_profiles_coverage_mode_check
  CHECK (coverage_mode IN ('LIST', 'NONE'));

COMMENT ON COLUMN public.covered_network_profiles.coverage_mode IS
  'LIST = entries define in-profile coverage; NONE = intentionally no covered MCC/MNC, used by fallback packages.';

CREATE OR REPLACE FUNCTION public.enforce_covered_network_profile_entries_mode()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_mode text;
BEGIN
  SELECT coverage_mode
    INTO v_mode
    FROM public.covered_network_profiles
   WHERE covered_network_profile_id = NEW.covered_network_profile_id;

  IF v_mode = 'NONE' THEN
    RAISE EXCEPTION 'coverage entries are not allowed when coverage_mode is NONE'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_covered_network_profile_entries_mode
  ON public.covered_network_profile_entries;

CREATE TRIGGER trg_covered_network_profile_entries_mode
  BEFORE INSERT OR UPDATE ON public.covered_network_profile_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_covered_network_profile_entries_mode();

COMMIT;
