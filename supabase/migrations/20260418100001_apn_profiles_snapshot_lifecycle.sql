-- APN profiles: single-row snapshot lifecycle (DRAFT / PUBLISHED / DEPRECATED).
-- Remove APN rows from profile_versions; drop legacy profile_status on apn_profiles.

-- ---------------------------------------------------------------------------
-- 1) New columns (idempotent)
-- ---------------------------------------------------------------------------
alter table public.apn_profiles add column if not exists published_at timestamptz;
alter table public.apn_profiles add column if not exists effective_from timestamptz;
alter table public.apn_profiles add column if not exists source_apn_profile_id uuid
  references public.apn_profiles(apn_profile_id);

-- ---------------------------------------------------------------------------
-- 2) One-time transform when apn_profiles.status still uses profile_status enum
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'apn_profiles'
      and c.column_name = 'status'
      and c.udt_name = 'profile_status'
  ) then
    alter table public.apn_profiles rename column status to legacy_carrier_status;

    alter table public.apn_profiles add column lifecycle_status text not null default 'DRAFT';

    update public.apn_profiles p
    set
      lifecycle_status = case
        when p.legacy_carrier_status::text = 'DEPRECATED' then 'DEPRECATED'
        when l.vs = 'PUBLISHED' then 'PUBLISHED'
        else 'DRAFT'
      end,
      published_at = case
        when l.vs = 'PUBLISHED' then coalesce(l.vf, l.vc)
        else null
      end,
      effective_from = case
        when l.vs = 'PUBLISHED' then coalesce(l.vf, l.vc)
        else null
      end
    from (
      select distinct on (profile_id)
        profile_id,
        status::text as vs,
        effective_from as vf,
        created_at as vc
      from public.profile_versions
      where profile_type = 'APN'
      order by profile_id, version desc
    ) as l
    where l.profile_id = p.apn_profile_id;

    update public.apn_profiles p
    set lifecycle_status = case
      when p.legacy_carrier_status::text = 'DEPRECATED' then 'DEPRECATED'
      else 'DRAFT'
    end
    where not exists (
      select 1
      from public.profile_versions v
      where v.profile_type = 'APN' and v.profile_id = p.apn_profile_id
    );

    delete from public.profile_change_requests r
    using public.profile_versions v
    where r.profile_version_id = v.profile_version_id
      and v.profile_type = 'APN';

    delete from public.profile_versions where profile_type = 'APN';

    alter table public.apn_profiles drop column legacy_carrier_status;
    alter table public.apn_profiles rename column lifecycle_status to status;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Ensure CHECK constraint on text status (idempotent)
-- ---------------------------------------------------------------------------
alter table public.apn_profiles drop constraint if exists apn_profiles_status_check;
alter table public.apn_profiles
  add constraint apn_profiles_status_check
  check (status in ('DRAFT', 'PUBLISHED', 'DEPRECATED'));

create index if not exists idx_apn_profiles_supplier_status
  on public.apn_profiles(supplier_id, status);
