-- Carrier service JSON stored on carrier_service_modules and package_versions:
-- drop legacy literal `apn`, embedded `roamingProfile`, and version-id keys.
-- Backfill `apnProfileId` from `apn` + supplier/operator when possible.
-- Backfill `roamingProfileId` from `roamingProfile.profileId` when the top-level id is missing.
--
-- Rows that still lack apnProfileId or roamingProfileId after this script need manual cleanup
-- (no matching apn_profiles row, or embedded roaming profile without profileId).

-- ---------------------------------------------------------------------------
-- 1) carrier_service_modules.carrier_service_config
-- ---------------------------------------------------------------------------
update public.carrier_service_modules c
set carrier_service_config = (
  jsonb_strip_nulls(
    c.carrier_service_config
      || jsonb_build_object(
        'apnProfileId',
        coalesce(
          nullif(c.carrier_service_config->>'apnProfileId', ''),
          (
            select ap.apn_profile_id::text
            from public.apn_profiles ap
            where c.carrier_service_config ? 'apn'
              and ap.supplier_id = (c.carrier_service_config->>'supplierId')::uuid
              and ap.apn = (c.carrier_service_config->>'apn')
              and (
                ap.operator_id is null
                or ap.operator_id = (c.carrier_service_config->>'operatorId')::uuid
              )
            order by (ap.operator_id is not null) desc, ap.apn_profile_id asc
            limit 1
          )
        ),
        'roamingProfileId',
        coalesce(
          nullif(c.carrier_service_config->>'roamingProfileId', ''),
          nullif(c.carrier_service_config#>>'{roamingProfile,profileId}', '')
        )
      )
  )
  - 'apn'
  - 'roamingProfile'
  - 'apnProfileVersionId'
  - 'roamingProfileVersionId'
)
where
  c.carrier_service_config ? 'apn'
  or c.carrier_service_config ? 'roamingProfile'
  or c.carrier_service_config ? 'apnProfileVersionId'
  or c.carrier_service_config ? 'roamingProfileVersionId';

-- ---------------------------------------------------------------------------
-- 2) package_versions.carrier_service_config (denormalized snapshot)
-- ---------------------------------------------------------------------------
update public.package_versions pv
set carrier_service_config = (
  jsonb_strip_nulls(
    pv.carrier_service_config
      || jsonb_build_object(
        'apnProfileId',
        coalesce(
          nullif(pv.carrier_service_config->>'apnProfileId', ''),
          (
            select ap.apn_profile_id::text
            from public.apn_profiles ap
            where pv.carrier_service_config ? 'apn'
              and ap.supplier_id = (pv.carrier_service_config->>'supplierId')::uuid
              and ap.apn = (pv.carrier_service_config->>'apn')
              and (
                ap.operator_id is null
                or ap.operator_id = (pv.carrier_service_config->>'operatorId')::uuid
              )
            order by (ap.operator_id is not null) desc, ap.apn_profile_id asc
            limit 1
          )
        ),
        'roamingProfileId',
        coalesce(
          nullif(pv.carrier_service_config->>'roamingProfileId', ''),
          nullif(pv.carrier_service_config#>>'{roamingProfile,profileId}', '')
        )
      )
  )
  - 'apn'
  - 'roamingProfile'
  - 'apnProfileVersionId'
  - 'roamingProfileVersionId'
)
where
  pv.carrier_service_config is not null
  and (
    pv.carrier_service_config ? 'apn'
    or pv.carrier_service_config ? 'roamingProfile'
    or pv.carrier_service_config ? 'apnProfileVersionId'
    or pv.carrier_service_config ? 'roamingProfileVersionId'
  );
