-- Roaming profiles: single-table snapshot lifecycle (DRAFT / PUBLISHED / DEPRECATED),
-- aligned with apn_profiles. Removes ROAMING rows from profile_versions.

-- ---------------------------------------------------------------------------
-- 1) Snapshot columns
-- ---------------------------------------------------------------------------
alter table public.roaming_profiles
  add column if not exists published_at timestamptz,
  add column if not exists effective_from timestamptz,
  add column if not exists source_roaming_profile_id uuid
    references public.roaming_profiles(roaming_profile_id);

-- ---------------------------------------------------------------------------
-- 2) Remap JSON refs (profile_version_id -> roaming profile_id) while versions exist
-- ---------------------------------------------------------------------------
update public.carrier_service_modules c
set carrier_service_config =
  (c.carrier_service_config - 'roamingProfileVersionId')
  || jsonb_build_object(
    'roamingProfileId',
    coalesce(
      (
        select pv.profile_id::text
        from public.profile_versions pv
        where pv.profile_type = 'ROAMING'
          and pv.profile_version_id::text = (c.carrier_service_config->>'roamingProfileVersionId')
        limit 1
      ),
      c.carrier_service_config->>'roamingProfileId'
    )
  )
where c.carrier_service_config ? 'roamingProfileVersionId';

update public.package_versions pv
set carrier_service_config =
  (pv.carrier_service_config - 'roamingProfileVersionId')
  || jsonb_build_object(
    'roamingProfileId',
    coalesce(
      (
        select v.profile_id::text
        from public.profile_versions v
        where v.profile_type = 'ROAMING'
          and v.profile_version_id::text = (pv.carrier_service_config->>'roamingProfileVersionId')
        limit 1
      ),
      pv.carrier_service_config->>'roamingProfileId'
    )
  )
where pv.carrier_service_config ? 'roamingProfileVersionId';

update public.package_versions pv
set roaming_profile =
  (pv.roaming_profile - 'profileVersionId')
  || jsonb_build_object(
    'profileId',
    coalesce(
      (
        select v.profile_id::text
        from public.profile_versions v
        where v.profile_type = 'ROAMING'
          and v.profile_version_id::text = (pv.roaming_profile->>'profileVersionId')
        limit 1
      ),
      pv.roaming_profile->>'profileId'
    )
  )
where pv.roaming_profile ? 'profileVersionId';

-- ---------------------------------------------------------------------------
-- 2b) mccmnc_list: legacy text[] (hyphenated MCC-MNC strings) -> jsonb array of rate entries
--     Required before merge: profile_versions.config->mccmncList is jsonb; COALESCE cannot mix jsonb + text[].
--     PG forbids subqueries inside ALTER COLUMN ... USING; use add column + update + swap instead.
--     Skipped when column is already jsonb.
-- ---------------------------------------------------------------------------
do $mcc$
begin
  if exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'roaming_profiles'
      and c.column_name = 'mccmnc_list'
      and c.data_type = 'ARRAY'
      and c.udt_name = '_text'
  ) then
    alter table public.roaming_profiles drop column if exists _mcc_mig_tmp;
    alter table public.roaming_profiles
      add column _mcc_mig_tmp jsonb not null default '[]'::jsonb;

    update public.roaming_profiles rp
    set _mcc_mig_tmp = coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'mcc', split_part(btrim(x), '-', 1),
            'mnc', nullif(btrim(split_part(btrim(x), '-', 2)), ''),
            'ratePerMb', 0::numeric
          )
          order by ord
        )
        from unnest(rp.mccmnc_list) with ordinality as u(x, ord)
      ),
      '[]'::jsonb
    );

    alter table public.roaming_profiles drop column mccmnc_list;
    alter table public.roaming_profiles rename column _mcc_mig_tmp to mccmnc_list;
    alter table public.roaming_profiles alter column mccmnc_list drop default;
  end if;
end$mcc$;

-- ---------------------------------------------------------------------------
-- 3) Merge latest ROAMING profile_version into roaming_profiles row + lifecycle text
-- ---------------------------------------------------------------------------
alter table public.roaming_profiles add column if not exists lifecycle_status text;

update public.roaming_profiles rp
set
  mccmnc_list = coalesce(lv.cfg_list, rp.mccmnc_list),
  published_at = case when lv.vs = 'PUBLISHED' then coalesce(lv.vf, lv.vc) else null end,
  effective_from = case when lv.vs = 'PUBLISHED' then coalesce(lv.vf, lv.vc) else null end,
  lifecycle_status = case
    when rp.status::text = 'DEPRECATED' then 'DEPRECATED'
    when lv.vs = 'PUBLISHED' then 'PUBLISHED'
    when lv.vs = 'DRAFT' then 'DRAFT'
    else 'DRAFT'
  end
from (
  select distinct on (pv.profile_id)
    pv.profile_id,
    pv.status::text as vs,
    pv.effective_from as vf,
    pv.created_at as vc,
    pv.config->'mccmncList' as cfg_list
  from public.profile_versions pv
  where pv.profile_type = 'ROAMING'
  order by pv.profile_id, pv.version desc
) lv
where rp.roaming_profile_id = lv.profile_id;

update public.roaming_profiles rp
set lifecycle_status = case
    when rp.status::text = 'DEPRECATED' then 'DEPRECATED'
    else 'DRAFT'
  end
where rp.lifecycle_status is null;

update public.roaming_profiles
set lifecycle_status = 'DRAFT'
where lifecycle_status is null;

-- ---------------------------------------------------------------------------
-- 4) Drop ROAMING profile_versions + scheduled change rows
-- ---------------------------------------------------------------------------
delete from public.profile_change_requests r
using public.profile_versions v
where r.profile_version_id = v.profile_version_id
  and v.profile_type = 'ROAMING';

delete from public.profile_versions
where profile_type = 'ROAMING';

-- ---------------------------------------------------------------------------
-- 5) Replace enum/text status with DRAFT/PUBLISHED/DEPRECATED text + CHECK
-- ---------------------------------------------------------------------------
alter table public.roaming_profiles drop constraint if exists roaming_profiles_status_check;
alter table public.roaming_profiles drop constraint if exists roaming_profiles_status_profile_status_check;

alter table public.roaming_profiles
  drop column if exists status;

alter table public.roaming_profiles
  rename column lifecycle_status to status;

alter table public.roaming_profiles
  alter column status set not null;

alter table public.roaming_profiles
  alter column status set default 'DRAFT';

alter table public.roaming_profiles
  add constraint roaming_profiles_status_check
  check (status in ('DRAFT', 'PUBLISHED', 'DEPRECATED'));

create index if not exists idx_roaming_profiles_supplier_status
  on public.roaming_profiles(supplier_id, status);
