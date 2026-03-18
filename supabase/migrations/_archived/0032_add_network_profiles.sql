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

create table if not exists apn_profiles (
  apn_profile_id uuid primary key default gen_random_uuid(),
  name text not null,
  apn text not null,
  auth_type apn_auth_type not null default 'NONE',
  username text,
  password_ref text,
  supplier_id uuid not null references suppliers(supplier_id),
  carrier_id uuid references carriers(carrier_id),
  status profile_status not null default 'ACTIVE',
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create table if not exists roaming_profiles (
  roaming_profile_id uuid primary key default gen_random_uuid(),
  name text not null,
  mccmnc_list text[] not null,
  supplier_id uuid not null references suppliers(supplier_id),
  carrier_id uuid references carriers(carrier_id),
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
