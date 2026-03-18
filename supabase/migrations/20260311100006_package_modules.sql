-- V006_package_modules.sql
-- Package module tables for commercial terms, control policy, carrier service
-- Sources: 0046 + 0047
-- Bug fix: FK references changed from customers(customer_id)/resellers(reseller_id) to customers(id)/resellers(id)
--
-- Rollback:
--   ALTER TABLE package_versions DROP COLUMN IF EXISTS carrier_service_id,
--     DROP COLUMN IF EXISTS carrier_service_config,
--     DROP COLUMN IF EXISTS control_policy_id,
--     DROP COLUMN IF EXISTS commercial_terms_id;
--   DROP TABLE IF EXISTS carrier_service_modules, control_policy_modules,
--     commercial_terms_modules CASCADE;

-- ============================================================
-- Module tables (from 0046, FK bug fixed)
-- ============================================================

create table if not exists commercial_terms_modules (
  commercial_terms_id uuid primary key default gen_random_uuid(),
  enterprise_id uuid references customers(id) on delete set null,
  reseller_id uuid references resellers(id) on delete set null,
  commercial_terms jsonb not null,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create index if not exists idx_commercial_terms_modules_enterprise_id
  on commercial_terms_modules(enterprise_id);

create table if not exists control_policy_modules (
  control_policy_id uuid primary key default gen_random_uuid(),
  enterprise_id uuid references customers(id) on delete set null,
  reseller_id uuid references resellers(id) on delete set null,
  control_policy jsonb not null,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create index if not exists idx_control_policy_modules_enterprise_id
  on control_policy_modules(enterprise_id);

create table if not exists carrier_service_modules (
  carrier_service_id uuid primary key default gen_random_uuid(),
  enterprise_id uuid references customers(id) on delete set null,
  reseller_id uuid references resellers(id) on delete set null,
  supplier_id uuid,
  operator_id uuid,
  carrier_service_config jsonb not null,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create index if not exists idx_carrier_service_modules_enterprise_id
  on carrier_service_modules(enterprise_id);

create index if not exists idx_carrier_service_modules_supplier_operator
  on carrier_service_modules(supplier_id, operator_id);

-- ============================================================
-- package_versions module refs (from 0047)
-- ============================================================

alter table package_versions
  add column if not exists carrier_service_id uuid references carrier_service_modules(carrier_service_id) on delete set null,
  add column if not exists carrier_service_config jsonb,
  add column if not exists control_policy_id uuid references control_policy_modules(control_policy_id) on delete set null,
  add column if not exists commercial_terms_id uuid references commercial_terms_modules(commercial_terms_id) on delete set null;

create index if not exists idx_package_versions_carrier_service_id
  on package_versions(carrier_service_id);

create index if not exists idx_package_versions_control_policy_id
  on package_versions(control_policy_id);

create index if not exists idx_package_versions_commercial_terms_id
  on package_versions(commercial_terms_id);
