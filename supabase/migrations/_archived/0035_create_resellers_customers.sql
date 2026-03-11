do $$
begin
  if not exists (select 1 from pg_type where typname = 'reseller_status') then
    create type reseller_status as enum ('active', 'deactivated', 'suspended');
  end if;
  if not exists (select 1 from pg_type where typname = 'customer_status') then
    create type customer_status as enum ('active', 'overdue', 'terminated');
  end if;
end $$;

create table if not exists resellers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status reseller_status not null default 'active',
  contact_email text,
  contact_phone text,
  created_by uuid,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  reseller_id uuid not null references resellers(id),
  name text not null,
  status customer_status not null default 'active',
  api_key text,
  api_secret_hash bytea,
  webhook_url text,
  auto_suspend_enabled boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (reseller_id, name)
);
