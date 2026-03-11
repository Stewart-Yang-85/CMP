create table if not exists commercial_terms_modules (
  commercial_terms_id uuid primary key default gen_random_uuid(),
  enterprise_id uuid references customers(customer_id) on delete set null,
  reseller_id uuid references resellers(reseller_id) on delete set null,
  commercial_terms jsonb not null,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create index if not exists idx_commercial_terms_modules_enterprise_id
  on commercial_terms_modules(enterprise_id);

create table if not exists control_policy_modules (
  control_policy_id uuid primary key default gen_random_uuid(),
  enterprise_id uuid references customers(customer_id) on delete set null,
  reseller_id uuid references resellers(reseller_id) on delete set null,
  control_policy jsonb not null,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create index if not exists idx_control_policy_modules_enterprise_id
  on control_policy_modules(enterprise_id);

create table if not exists carrier_service_modules (
  carrier_service_id uuid primary key default gen_random_uuid(),
  enterprise_id uuid references customers(customer_id) on delete set null,
  reseller_id uuid references resellers(reseller_id) on delete set null,
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
