-- V005_billing_integration.sql
-- Billing integration domain: dunning, alerts, webhooks, billing config
-- Sources: 0020 + 0021 + 0022 + 0033 + 0034_webhook_alert_type
-- Bug fix: alert_type ENUM includes WEBHOOK_DELIVERY_FAILED from start (merged 0034)
--
-- Rollback:
--   DROP TABLE IF EXISTS late_fee_rules, control_policies, dunning_policies, billing_config,
--     webhook_deliveries, webhook_subscriptions, alerts, dunning_actions, dunning_records CASCADE;
--   DROP TYPE IF EXISTS dunning_status, alert_type, alert_severity, alert_status CASCADE;

-- ============================================================
-- ENUMs
-- ============================================================

do $$
begin
  -- from 0020
  if not exists (select 1 from pg_type where typname = 'dunning_status') then
    create type dunning_status as enum ('NORMAL', 'OVERDUE_WARNING', 'SUSPENDED', 'SERVICE_INTERRUPTED');
  end if;

  -- from 0021 + 0034_webhook_alert_type (WEBHOOK_DELIVERY_FAILED merged in)
  if not exists (select 1 from pg_type where typname = 'alert_type') then
    create type alert_type as enum ('POOL_USAGE_HIGH', 'OUT_OF_PROFILE_SURGE', 'SILENT_SIM', 'UNEXPECTED_ROAMING', 'CDR_DELAY', 'UPSTREAM_DISCONNECT', 'WEBHOOK_DELIVERY_FAILED');
  end if;

  if not exists (select 1 from pg_type where typname = 'alert_severity') then
    create type alert_severity as enum ('P0', 'P1', 'P2', 'P3');
  end if;

  if not exists (select 1 from pg_type where typname = 'alert_status') then
    create type alert_status as enum ('OPEN', 'ACKED', 'RESOLVED', 'SUPPRESSED');
  end if;
end $$;

-- ============================================================
-- Tables
-- ============================================================

-- dunning_records (from 0020)
create table if not exists dunning_records (
  dunning_id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references tenants(tenant_id),
  bill_id uuid not null references bills(bill_id),
  dunning_status dunning_status not null default 'NORMAL',
  overdue_since date,
  grace_period_days int not null default 3,
  suspend_triggered_at timestamptz,
  interruption_triggered_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (customer_id, bill_id)
);

create index if not exists idx_dunning_customer_status
  on dunning_records(customer_id, dunning_status);

-- dunning_actions (from 0020)
create table if not exists dunning_actions (
  action_id bigserial primary key,
  dunning_id uuid not null references dunning_records(dunning_id),
  action_type text not null,
  channel text,
  delivery_status text,
  metadata jsonb,
  created_at timestamptz not null default current_timestamp
);

-- alerts (from 0021)
create table if not exists alerts (
  alert_id uuid primary key default gen_random_uuid(),
  alert_type alert_type not null,
  severity alert_severity not null,
  status alert_status not null default 'OPEN',
  rule_id uuid,
  rule_version int,
  reseller_id uuid not null references tenants(tenant_id),
  customer_id uuid references tenants(tenant_id),
  sim_id uuid references sims(sim_id),
  threshold numeric,
  current_value numeric,
  window_start timestamptz not null,
  window_end timestamptz,
  first_seen_at timestamptz not null default current_timestamp,
  last_seen_at timestamptz not null default current_timestamp,
  acknowledged_at timestamptz,
  acknowledged_by uuid references users(user_id),
  suppressed_until timestamptz,
  delivery_channels text[],
  metadata jsonb,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (reseller_id, sim_id, alert_type, window_start)
);

create index if not exists idx_alerts_reseller_type
  on alerts(reseller_id, alert_type, created_at);
create index if not exists idx_alerts_status
  on alerts(status, severity, created_at);

-- webhook_subscriptions (from 0022)
create table if not exists webhook_subscriptions (
  webhook_id uuid primary key default gen_random_uuid(),
  reseller_id uuid references tenants(tenant_id),
  customer_id uuid references tenants(tenant_id),
  url text not null,
  secret text not null,
  event_types text[] not null,
  enabled boolean not null default true,
  description text,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  check (reseller_id is not null or customer_id is not null)
);

-- webhook_deliveries (from 0022)
create table if not exists webhook_deliveries (
  delivery_id bigserial primary key,
  webhook_id uuid not null references webhook_subscriptions(webhook_id),
  event_id uuid not null references events(event_id),
  attempt int not null default 1,
  status text not null default 'PENDING',
  response_code int,
  response_body text,
  next_retry_at timestamptz,
  created_at timestamptz not null default current_timestamp
);

create index if not exists idx_webhook_deliveries_status
  on webhook_deliveries(status, next_retry_at);

-- billing_config (from 0033)
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

-- dunning_policies (from 0033)
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

-- control_policies (from 0033)
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

-- late_fee_rules (from 0033)
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
