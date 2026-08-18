-- Phase 33 (tasks.md T249): carrier_service_modules — APN / Roaming FK columns + rat
--
-- Aligns with tasks.md §33.0:
--   1) ADD apn_profile_id, roaming_profile_id (nullable), rat (nullable until backfill).
--   2) BACKFILL UUIDs from carrier_service_config JSON (regex-gated cast); rat normalized.
--   3) SYNC JSON from columns where both profile FKs present (supplier_id/operator_id from **columns** win).
--   4) ORPHAN guard before FK; ADD FK ON DELETE RESTRICT (idempotent constraint names).
--   5) CHECK (rat); ALTER rat SET DEFAULT + NOT NULL — **本迁移仅 rat NOT NULL**；profile 列保持可空以兼容
--      未回填或历史脏行（后续若全量干净可加 apn/roaming NOT NULL 另起迁移）。
--
-- Truth source: apn_profile_id, roaming_profile_id, rat (+ supplier_id / operator_id).
-- carrier_service_config JSON = API mirror; app dual-writes (see package.ts).
--
-- Rollback (manual, non-trivial if NOT NULL / FKs applied):
--   ALTER TABLE public.carrier_service_modules
--     DROP CONSTRAINT IF EXISTS carrier_service_modules_rat_check,
--     DROP CONSTRAINT IF EXISTS carrier_service_modules_apn_profile_id_fkey,
--     DROP CONSTRAINT IF EXISTS carrier_service_modules_roaming_profile_id_fkey;
--   DROP INDEX IF EXISTS idx_carrier_service_modules_apn_profile_id;
--   DROP INDEX IF EXISTS idx_carrier_service_modules_roaming_profile_id;
--   ALTER TABLE public.carrier_service_modules
--     DROP COLUMN IF EXISTS apn_profile_id,
--     DROP COLUMN IF EXISTS roaming_profile_id,
--     DROP COLUMN IF EXISTS rat;

BEGIN;

ALTER TABLE public.carrier_service_modules
  ADD COLUMN IF NOT EXISTS apn_profile_id uuid,
  ADD COLUMN IF NOT EXISTS roaming_profile_id uuid,
  ADD COLUMN IF NOT EXISTS rat text;

-- Backfill UUIDs from JSON (safe cast: regex gate)
UPDATE public.carrier_service_modules c
SET apn_profile_id = (nullif(trim(c.carrier_service_config->>'apnProfileId'), ''))::uuid
WHERE c.apn_profile_id IS NULL
  AND c.carrier_service_config ? 'apnProfileId'
  AND nullif(trim(c.carrier_service_config->>'apnProfileId'), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

UPDATE public.carrier_service_modules c
SET roaming_profile_id = (nullif(trim(c.carrier_service_config->>'roamingProfileId'), ''))::uuid
WHERE c.roaming_profile_id IS NULL
  AND c.carrier_service_config ? 'roamingProfileId'
  AND nullif(trim(c.carrier_service_config->>'roamingProfileId'), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- rat: normalize from JSON or default 4G
UPDATE public.carrier_service_modules c
SET rat = CASE
  WHEN upper(replace(trim(c.carrier_service_config->>'rat'), '-', '')) IN ('NBIOT', 'NB-IOT', 'NB_IOT') THEN 'NB-IOT'
  WHEN upper(trim(c.carrier_service_config->>'rat')) IN ('3G', '4G', '5G') THEN upper(trim(c.carrier_service_config->>'rat'))
  WHEN nullif(trim(c.rat), '') IS NOT NULL THEN
    CASE
      WHEN upper(replace(trim(c.rat), '-', '')) IN ('NBIOT', 'NB-IOT', 'NB_IOT') THEN 'NB-IOT'
      WHEN upper(trim(c.rat)) IN ('3G', '4G', '5G', 'NB-IOT') THEN upper(trim(c.rat))
      ELSE '4G'
    END
  ELSE '4G'
END
WHERE c.rat IS NULL OR trim(c.rat) = '';

UPDATE public.carrier_service_modules
SET rat = '4G'
WHERE rat IS NULL OR trim(rat) = '';

-- Coerce any non-canonical rat before CHECK constraint
UPDATE public.carrier_service_modules
SET rat = CASE
  WHEN upper(replace(trim(rat), '-', '')) IN ('NBIOT', 'NB-IOT', 'NB_IOT') THEN 'NB-IOT'
  WHEN upper(trim(rat)) IN ('3G', '4G', '5G') THEN upper(trim(rat))
  ELSE '4G'
END
WHERE rat IS NULL
  OR trim(rat) = ''
  OR upper(replace(trim(rat), '-', '')) NOT IN ('3G', '4G', '5G', 'NBIOT', 'NB-IOT', 'NB_IOT');

-- Keep JSON aligned with columns (dual-write compatibility for older app builds)
UPDATE public.carrier_service_modules c
SET carrier_service_config = jsonb_strip_nulls(
  coalesce(c.carrier_service_config, '{}'::jsonb)
  || jsonb_build_object(
    'supplierId', c.supplier_id::text,
    'operatorId', c.operator_id::text,
    'apnProfileId', c.apn_profile_id::text,
    'roamingProfileId', c.roaming_profile_id::text,
    'rat', c.rat
  )
)
WHERE c.apn_profile_id IS NOT NULL
  AND c.roaming_profile_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.carrier_service_modules c
    WHERE c.apn_profile_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.apn_profiles a WHERE a.apn_profile_id = c.apn_profile_id
      )
  ) THEN
    RAISE EXCEPTION 'carrier_service_modules.apn_profile_id: orphan reference(s); fix JSON / rows before FK';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.carrier_service_modules c
    WHERE c.roaming_profile_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.roaming_profiles r WHERE r.roaming_profile_id = c.roaming_profile_id
      )
  ) THEN
    RAISE EXCEPTION 'carrier_service_modules.roaming_profile_id: orphan reference(s); fix JSON / rows before FK';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'carrier_service_modules_apn_profile_id_fkey'
      AND conrelid = 'public.carrier_service_modules'::regclass
  ) THEN
    ALTER TABLE public.carrier_service_modules
      ADD CONSTRAINT carrier_service_modules_apn_profile_id_fkey
        FOREIGN KEY (apn_profile_id) REFERENCES public.apn_profiles (apn_profile_id) ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'carrier_service_modules_roaming_profile_id_fkey'
      AND conrelid = 'public.carrier_service_modules'::regclass
  ) THEN
    ALTER TABLE public.carrier_service_modules
      ADD CONSTRAINT carrier_service_modules_roaming_profile_id_fkey
        FOREIGN KEY (roaming_profile_id) REFERENCES public.roaming_profiles (roaming_profile_id) ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'carrier_service_modules_rat_check'
      AND conrelid = 'public.carrier_service_modules'::regclass
  ) THEN
    ALTER TABLE public.carrier_service_modules
      ADD CONSTRAINT carrier_service_modules_rat_check
        CHECK (rat IN ('3G', '4G', '5G', 'NB-IOT'));
  END IF;
END $$;

ALTER TABLE public.carrier_service_modules
  ALTER COLUMN rat SET DEFAULT '4G';

ALTER TABLE public.carrier_service_modules
  ALTER COLUMN rat SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_carrier_service_modules_apn_profile_id
  ON public.carrier_service_modules (apn_profile_id)
  WHERE apn_profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_carrier_service_modules_roaming_profile_id
  ON public.carrier_service_modules (roaming_profile_id)
  WHERE roaming_profile_id IS NOT NULL;

COMMIT;
