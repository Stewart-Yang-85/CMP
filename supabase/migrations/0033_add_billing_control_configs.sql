create table if not exists billing_config (
  config_id uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null references tenants(tenant_id),
  currency text,
  billing_cycle_type billing_cycle_type not null default 'CALENDAR_MONTH',
  first_cycle_proration first_cycle_proration not null default 'NONE',
  bill_day int,
  time_zone text,
  auto_generate boolean not null default true,
  auto_publish boolean not null default false,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (enterprise_id)
);

create table if not exists dunning_policies (
  policy_id uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null references tenants(tenant_id),
  grace_period_days int not null default 3,
  suspend_after_days int,
  interruption_after_days int,
  enabled boolean not null default true,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (enterprise_id)
);

create table if not exists control_policies (
  policy_id uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null references tenants(tenant_id),
  cutoff_enabled boolean not null default false,
  throttle_enabled boolean not null default false,
  throttle_kbps int,
  auto_reactivate boolean not null default false,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (enterprise_id)
);

create table if not exists late_fee_rules (
  rule_id uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null references tenants(tenant_id),
  fee_type text not null default 'PERCENTAGE',
  fee_value numeric(12,2) not null default 0,
  grace_period_days int not null default 0,
  enabled boolean not null default true,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (enterprise_id)
);
