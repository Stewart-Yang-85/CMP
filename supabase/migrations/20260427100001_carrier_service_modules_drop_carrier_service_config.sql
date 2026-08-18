-- Drop carrier_service_modules.carrier_service_config (JSONB). Persistence is
-- apn_profile_id, roaming_profile_id, rat, supplier_id, operator_id only.
-- Prerequisite: Phase 33 migration 20260425100001 (columns + backfill).
--
-- Rollback (non-trivial): re-add column NOT NULL default '{}'::jsonb and repopulate from columns + apn/roaming rows.

BEGIN;

-- Last-chance column backfill from JSON before the column disappears
UPDATE public.carrier_service_modules c
SET apn_profile_id = (nullif(trim(c.carrier_service_config->>'apnProfileId'), ''))::uuid
WHERE c.apn_profile_id IS NULL
  AND c.carrier_service_config IS NOT NULL
  AND c.carrier_service_config ? 'apnProfileId'
  AND nullif(trim(c.carrier_service_config->>'apnProfileId'), '')
    ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

UPDATE public.carrier_service_modules c
SET roaming_profile_id = (nullif(trim(c.carrier_service_config->>'roamingProfileId'), ''))::uuid
WHERE c.roaming_profile_id IS NULL
  AND c.carrier_service_config IS NOT NULL
  AND c.carrier_service_config ? 'roamingProfileId'
  AND nullif(trim(c.carrier_service_config->>'roamingProfileId'), '')
    ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

ALTER TABLE public.carrier_service_modules
  DROP COLUMN IF EXISTS carrier_service_config;

COMMIT;
