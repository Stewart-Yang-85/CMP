-- Phase 30 T228: Covered / roaming billing fetch — index alignment + statistics
--
-- Hot paths (see src/billing.js):
--   - covered_network_profile_entries: select=covered_network_profile_id,mcc,mnc&covered_network_profile_id=in.(...)
--   - roaming_profiles: select=roaming_profile_id,mccmnc_list&roaming_profile_id=in.(...)
--
-- covered_network_profile_entries already has UNIQUE (covered_network_profile_id, mcc, mnc) (20260422100007),
-- which creates a B-tree index usable on the leading column for IN (...) filters.
-- roaming_profiles.roaming_profile_id is the PRIMARY KEY — batch fetch by id uses PK index.
--
-- There is no normalized roaming_profile_entries table; OOP tariffs live in roaming_profiles.mccmnc_list (jsonb).

BEGIN;

COMMENT ON CONSTRAINT covered_network_profile_entries_mcc_mnc_unique ON public.covered_network_profile_entries IS
  'T228: UNIQUE(covered_network_profile_id,mcc,mnc). Batch billing uses covered_network_profile_id=in.(...); leading column of this index; target ~600 rows per profile.';

ANALYZE public.covered_network_profile_entries;
ANALYZE public.roaming_profiles;

COMMIT;
