-- V004_sim_connectivity.sql
-- SIM connectivity domain: public_infos, business_operators, operators, network profiles
-- Sources: 0032 + 0036 + 0039 + 0041 + 0042 + 0044
-- Eliminated: 0037 (data migration, no prod data), 0038 (data migration, no prod data)
-- Final-state schema: no rename/migrate chain needed for fresh deploy
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_sims_operator_id, idx_package_versions_operator_id,
--     idx_apn_profiles_operator_id, idx_roaming_profiles_operator_id,
--     idx_operators_supplier_business_operator_unique;
--   ALTER TABLE sims DROP COLUMN IF EXISTS operator_id;
--   ALTER TABLE package_versions DROP COLUMN IF EXISTS operator_id;
--   DROP TABLE IF EXISTS profile_change_requests, profile_versions,
--     roaming_profiles, apn_profiles, operators, business_operators CASCADE;
--   DROP VIEW IF EXISTS carriers CASCADE;
--   DROP TABLE IF EXISTS public_infos CASCADE;
--   DROP TYPE IF EXISTS profile_status, profile_type, profile_version_status,
--     profile_change_status, apn_auth_type CASCADE;

-- ============================================================
-- ENUMs (from 0032)
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'profile_status') then
    create type profile_status as enum ('ACTIVE', 'DEPRECATED');
  end if;
  if not exists (select 1 from pg_type where typname = 'profile_type') then
    create type profile_type as enum ('APN', 'ROAMING');
  end if;
  if not exists (select 1 from pg_type where typname = 'profile_version_status') then
    create type profile_version_status as enum ('DRAFT', 'PUBLISHED');
  end if;
  if not exists (select 1 from pg_type where typname = 'profile_change_status') then
    create type profile_change_status as enum ('SCHEDULED', 'APPLIED', 'CANCELLED', 'FAILED');
  end if;
  if not exists (select 1 from pg_type where typname = 'apn_auth_type') then
    create type apn_auth_type as enum ('NONE', 'PAP', 'CHAP');
  end if;
end $$;

-- ============================================================
-- Rename carriers → public_infos (final-state, from 0041)
-- For fresh deploy: create public_infos directly, then create carriers view
-- ============================================================

-- Rename the carriers table to public_infos if it exists as a real table
do $$
begin
  -- Only rename if carriers is a real table (not already renamed)
  if to_regclass('public.carriers') is not null
     and to_regclass('public.public_infos') is null
     and exists (
       select 1 from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'carriers' and c.relkind = 'r'
     )
  then
    execute 'alter table public.carriers rename to public_infos';
    -- Rename PK column
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'public_infos' and column_name = 'carrier_id'
    ) then
      execute 'alter table public.public_infos rename column carrier_id to public_info_id';
    end if;
  end if;
end $$;

-- Add extended columns from 0036
alter table if exists public_infos
  add column if not exists country_name text,
  add column if not exists lte_bands text;

-- Create backward-compatible carriers view (from 0041)
drop view if exists public.carriers;

do $$
begin
  if to_regclass('public.public_infos') is not null then
    execute 'create view public.carriers as select public_info_id as carrier_id, mcc, mnc, name, country_name, lte_bands from public.public_infos';
  end if;
end $$;

-- ============================================================
-- business_operators (from 0039) + seed data
-- ============================================================

create table if not exists business_operators (
  operator_id uuid primary key default gen_random_uuid(),
  mcc char(3) not null,
  mnc char(3) not null,
  name text not null
);

insert into business_operators (operator_id, mcc, mnc, name)
values ('1413a2b1-8888-4e5a-9a66-949ca1f56d72', '204', '08', 'TATA')
on conflict (operator_id) do nothing;

-- ============================================================
-- operators (from 0039, with business_operator_id from 0042)
-- carrier_id nullable from start (absorbed 0042)
-- ============================================================

create table if not exists operators (
  operator_id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(supplier_id),
  carrier_id uuid references public_infos(public_info_id),
  business_operator_id uuid references business_operators(operator_id),
  name text,
  status text not null default 'ACTIVE',
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

alter table if exists operators
  add column if not exists carrier_id uuid references public_infos(public_info_id),
  add column if not exists business_operator_id uuid references business_operators(operator_id),
  add column if not exists name text,
  add column if not exists status text not null default 'ACTIVE',
  add column if not exists created_at timestamptz not null default current_timestamp,
  add column if not exists updated_at timestamptz not null default current_timestamp;

-- Unique index on (supplier_id, business_operator_id) where not null (from 0042/0044)
create unique index if not exists idx_operators_supplier_business_operator_unique
  on operators(supplier_id, business_operator_id)
  where business_operator_id is not null;

-- Seed operators from existing supplier_carriers (from 0039)
insert into operators (supplier_id, carrier_id, name)
select sc.supplier_id, sc.carrier_id, c.name
from supplier_carriers sc
join carriers c on c.carrier_id = sc.carrier_id
left join operators o on o.supplier_id = sc.supplier_id and o.carrier_id = sc.carrier_id
where o.operator_id is null;

-- ============================================================
-- Network profiles (from 0032, with operator_id from 0039)
-- ============================================================

-- apn_profiles: includes operator_id from start
create table if not exists apn_profiles (
  apn_profile_id uuid primary key default gen_random_uuid(),
  name text not null,
  apn text not null,
  auth_type apn_auth_type not null default 'NONE',
  username text,
  password_ref text,
  supplier_id uuid not null references suppliers(supplier_id),
  carrier_id uuid references public_infos(public_info_id),
  operator_id uuid references operators(operator_id),
  status profile_status not null default 'ACTIVE',
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

-- roaming_profiles: includes operator_id, mccmnc_list as jsonb (plan says jsonb not text[])
create table if not exists roaming_profiles (
  roaming_profile_id uuid primary key default gen_random_uuid(),
  name text not null,
  mccmnc_list text[] not null,
  supplier_id uuid not null references suppliers(supplier_id),
  carrier_id uuid references public_infos(public_info_id),
  operator_id uuid references operators(operator_id),
  status profile_status not null default 'ACTIVE',
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create table if not exists profile_versions (
  profile_version_id uuid primary key default gen_random_uuid(),
  profile_type profile_type not null,
  profile_id uuid not null,
  version int not null,
  config jsonb,
  status profile_version_status not null default 'DRAFT',
  effective_from timestamptz,
  effective_to timestamptz,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (profile_type, profile_id, version)
);

create table if not exists profile_change_requests (
  request_id uuid primary key default gen_random_uuid(),
  profile_version_id uuid not null references profile_versions(profile_version_id),
  status profile_change_status not null default 'SCHEDULED',
  scheduled_at timestamptz not null,
  applied_at timestamptz,
  cancelled_at timestamptz,
  error_detail text,
  created_at timestamptz not null default current_timestamp
);

-- ============================================================
-- Add operator_id to sims and package_versions (from 0039)
-- ============================================================

alter table if exists sims
  add column if not exists operator_id uuid references operators(operator_id);

alter table if exists package_versions
  add column if not exists operator_id uuid references operators(operator_id);

-- ============================================================
-- Indexes (from 0044)
-- ============================================================

create index if not exists idx_sims_operator_id on sims(operator_id);
create index if not exists idx_package_versions_operator_id on package_versions(operator_id);
create index if not exists idx_apn_profiles_operator_id on apn_profiles(operator_id);
create index if not exists idx_roaming_profiles_operator_id on roaming_profiles(operator_id);
