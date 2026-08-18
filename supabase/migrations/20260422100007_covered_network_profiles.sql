-- Phase 30 T217: CoveredNetworkProfile (in-profile MCC/MNC coverage) + normalized entries.
-- Aligns with apn_profiles / roaming_profiles: supplier_id + operator_id; optional reseller tenant scope.
-- price_plans.covered_network_profile_id: nullable; in-profile plan types enforced at publish/API (T221).
-- OOP MUST NOT use price_plans.roaming_profile_id — column is not added (spec / Phase 30).
--
-- Rollback (manual):
--   ALTER TABLE public.price_plans DROP CONSTRAINT IF EXISTS price_plans_covered_network_profile_id_fkey;
--   ALTER TABLE public.price_plans DROP COLUMN IF EXISTS covered_network_profile_id;
--   DROP TABLE IF EXISTS public.covered_network_profile_entries;
--   DROP TABLE IF EXISTS public.covered_network_profiles;

BEGIN;

CREATE TABLE IF NOT EXISTS public.covered_network_profiles (
  covered_network_profile_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  reseller_id uuid REFERENCES public.tenants (tenant_id) ON DELETE SET NULL,
  supplier_id uuid NOT NULL REFERENCES public.suppliers (supplier_id),
  operator_id uuid NOT NULL REFERENCES public.operators (operator_id),
  status text NOT NULL DEFAULT 'DRAFT',
  published_at timestamptz,
  effective_from timestamptz,
  source_covered_network_profile_id uuid REFERENCES public.covered_network_profiles (covered_network_profile_id),
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  CONSTRAINT covered_network_profiles_status_check CHECK (status IN ('DRAFT', 'PUBLISHED', 'DEPRECATED'))
);

COMMENT ON TABLE public.covered_network_profiles IS
  'CoveredNetworkProfile snapshot: reusable (MCC,MNC) set for in-profile rating (Phase 30).';
COMMENT ON COLUMN public.covered_network_profiles.reseller_id IS
  'Optional reseller tenant (tenants.tenant_id); catalog scope — may be NULL like legacy apn/roaming rows.';
COMMENT ON COLUMN public.covered_network_profiles.source_covered_network_profile_id IS
  'Clone / revision lineage; same pattern as source_apn_profile_id / source_roaming_profile_id.';

CREATE INDEX IF NOT EXISTS idx_covered_network_profiles_supplier_status
  ON public.covered_network_profiles (supplier_id, status);

CREATE INDEX IF NOT EXISTS idx_covered_network_profiles_reseller_status
  ON public.covered_network_profiles (reseller_id, status)
  WHERE reseller_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.covered_network_profile_entries (
  entry_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  covered_network_profile_id uuid NOT NULL REFERENCES public.covered_network_profiles (covered_network_profile_id) ON DELETE CASCADE,
  mcc varchar(3) NOT NULL,
  mnc varchar(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  CONSTRAINT covered_network_profile_entries_mcc_mnc_unique UNIQUE (covered_network_profile_id, mcc, mnc)
);

COMMENT ON TABLE public.covered_network_profile_entries IS
  'Normalized coverage rows (~600/profile scale); UNIQUE(profile,mcc,mnc) supports batch rating point lookups.';

ALTER TABLE public.price_plans
  ADD COLUMN IF NOT EXISTS covered_network_profile_id uuid REFERENCES public.covered_network_profiles (covered_network_profile_id) ON DELETE RESTRICT;

COMMENT ON COLUMN public.price_plans.covered_network_profile_id IS
  'FK to CoveredNetworkProfile for in-profile rules; NULL for plan types that do not use covered network (see OpenAPI / publish validation).';

CREATE INDEX IF NOT EXISTS idx_price_plans_covered_network_profile_id
  ON public.price_plans (covered_network_profile_id)
  WHERE covered_network_profile_id IS NOT NULL;

ALTER TABLE public.covered_network_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS covered_network_profiles_no_anon_access ON public.covered_network_profiles;
CREATE POLICY covered_network_profiles_no_anon_access ON public.covered_network_profiles
  FOR ALL TO anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS covered_network_profiles_authenticated_full_access ON public.covered_network_profiles;
CREATE POLICY covered_network_profiles_authenticated_full_access ON public.covered_network_profiles
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE public.covered_network_profile_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS covered_network_profile_entries_no_anon_access ON public.covered_network_profile_entries;
CREATE POLICY covered_network_profile_entries_no_anon_access ON public.covered_network_profile_entries
  FOR ALL TO anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS covered_network_profile_entries_authenticated_full_access ON public.covered_network_profile_entries;
CREATE POLICY covered_network_profile_entries_authenticated_full_access ON public.covered_network_profile_entries
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
