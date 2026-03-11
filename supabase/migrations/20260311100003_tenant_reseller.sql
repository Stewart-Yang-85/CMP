-- V003_tenant_reseller.sql
-- Tenant & reseller domain: resellers, customers, branding, assignments, suppliers
-- Sources: 0035 + 0019 + 0034_reseller_enterprise_assignments + 0043 + 0031(idx only)
-- Eliminated: 0031 (ALTER redundant, 0035 already has api_key), 0040 (duplicate of 0001)
-- Bug fix: ENUM values uppercased per D-30 decision
--
-- Rollback:
--   DROP TABLE IF EXISTS reseller_suppliers, reseller_enterprise_assignments,
--     reseller_branding, customers, resellers CASCADE;
--   DROP TYPE IF EXISTS reseller_status, customer_status CASCADE;

-- ============================================================
-- ENUMs (D-30: uppercase values)
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'reseller_status') then
    create type reseller_status as enum ('ACTIVE', 'DEACTIVATED', 'SUSPENDED');
  end if;
  if not exists (select 1 from pg_type where typname = 'customer_status') then
    create type customer_status as enum ('ACTIVE', 'OVERDUE', 'TERMINATED');
  end if;
end $$;

-- ============================================================
-- Tables
-- ============================================================

-- resellers (from 0035, status default uppercased)
create table if not exists resellers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status reseller_status not null default 'ACTIVE',
  contact_email text,
  contact_phone text,
  created_by uuid,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

-- customers (from 0035, already contains api_key/api_secret_hash/webhook_url)
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  reseller_id uuid not null references resellers(id),
  name text not null,
  status customer_status not null default 'ACTIVE',
  api_key text,
  api_secret_hash bytea,
  webhook_url text,
  auto_suspend_enabled boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (reseller_id, name)
);

-- from 0031: only the unique index is useful (ALTER columns already in CREATE above)
create unique index if not exists idx_customers_api_key on customers(api_key);

-- reseller_branding (from 0019)
create table if not exists reseller_branding (
  branding_id uuid primary key default gen_random_uuid(),
  reseller_id uuid not null references tenants(tenant_id) unique,
  brand_name text,
  logo_url text,
  custom_domain text,
  primary_color text,
  secondary_color text,
  currency text not null default 'CNY',
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

-- reseller_enterprise_assignments (from 0034)
create table if not exists reseller_enterprise_assignments (
  user_id uuid not null references users(user_id),
  reseller_id uuid not null references tenants(tenant_id),
  enterprise_id uuid not null references tenants(tenant_id),
  created_at timestamptz not null default current_timestamp,
  primary key (user_id, enterprise_id)
);

create index if not exists idx_reseller_assignments_reseller on reseller_enterprise_assignments(reseller_id);
create index if not exists idx_reseller_assignments_enterprise on reseller_enterprise_assignments(enterprise_id);

-- reseller_suppliers (from 0043)
create table if not exists reseller_suppliers (
  reseller_id uuid not null references resellers(id),
  supplier_id uuid not null references suppliers(supplier_id),
  created_at timestamptz not null default current_timestamp,
  primary key (reseller_id, supplier_id)
);

create index if not exists idx_reseller_suppliers_supplier on reseller_suppliers(supplier_id);
