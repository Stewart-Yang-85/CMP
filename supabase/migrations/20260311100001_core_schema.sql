-- V001_core_schema.sql
-- Consolidated core schema for IoT CMP
-- Sources: 0001 + 0008_rating_results + 0014 + 0015 + 0016 + 0023 + 0024 + 0025 + 0026 + 0027 + 0028 + 0029 + 0045 + api_clients
-- Eliminated: 0017 (already in 0001), 0018 (superseded by 0026)
--
-- Rollback:
--   DROP TABLE IF EXISTS api_clients, reconciliation_runs, provisioning_orders, vendor_product_mappings,
--     share_links, adjustment_note_items, adjustment_notes, rating_results, bill_line_items, bills,
--     usage_daily_summary, cdr_files, subscriptions, package_versions, packages, price_plan_versions,
--     price_plans, sim_state_history, sims, events, jobs, enterprise_user_departments, user_roles,
--     users, audit_logs, tenants, supplier_carriers, carriers, suppliers CASCADE;
--   DROP TYPE IF EXISTS tenant_type, enterprise_status, sim_status, subscription_state, job_status,
--     bill_status, service_type, billing_cycle_type, first_cycle_proration, price_plan_type,
--     note_type, note_status, subscription_kind, sim_form_factor, provisioning_status CASCADE;

create extension if not exists pgcrypto;

-- ============================================================
-- ENUMs
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'tenant_type') then
    create type tenant_type as enum ('RESELLER', 'ENTERPRISE', 'DEPARTMENT');
  end if;

  if not exists (select 1 from pg_type where typname = 'enterprise_status') then
    create type enterprise_status as enum ('ACTIVE', 'SUSPENDED', 'INACTIVE');
  end if;

  if not exists (select 1 from pg_type where typname = 'sim_status') then
    create type sim_status as enum ('INVENTORY', 'TEST_READY', 'ACTIVATED', 'DEACTIVATED', 'RETIRED');
  end if;

  if not exists (select 1 from pg_type where typname = 'subscription_state') then
    create type subscription_state as enum ('PENDING', 'ACTIVE', 'CANCELLED', 'EXPIRED');
  end if;

  if not exists (select 1 from pg_type where typname = 'job_status') then
    create type job_status as enum ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
  end if;

  if not exists (select 1 from pg_type where typname = 'bill_status') then
    create type bill_status as enum ('GENERATED', 'PUBLISHED', 'PAID', 'OVERDUE', 'WRITTEN_OFF');
  end if;

  if not exists (select 1 from pg_type where typname = 'service_type') then
    create type service_type as enum ('DATA', 'VOICE', 'SMS');
  end if;

  if not exists (select 1 from pg_type where typname = 'billing_cycle_type') then
    create type billing_cycle_type as enum ('CALENDAR_MONTH', 'CUSTOM_RANGE');
  end if;

  if not exists (select 1 from pg_type where typname = 'first_cycle_proration') then
    create type first_cycle_proration as enum ('NONE', 'DAILY_PRORATION');
  end if;

  if not exists (select 1 from pg_type where typname = 'price_plan_type') then
    create type price_plan_type as enum ('ONE_TIME', 'SIM_DEPENDENT_BUNDLE', 'FIXED_BUNDLE', 'TIERED_VOLUME_PRICING');
  end if;

  if not exists (select 1 from pg_type where typname = 'note_type') then
    create type note_type as enum ('CREDIT', 'DEBIT');
  end if;

  if not exists (select 1 from pg_type where typname = 'note_status') then
    create type note_status as enum ('DRAFT', 'APPROVED', 'APPLIED', 'CANCELLED');
  end if;

  if not exists (select 1 from pg_type where typname = 'subscription_kind') then
    create type subscription_kind as enum ('MAIN', 'ADD_ON');
  end if;

  -- from 0026
  if not exists (select 1 from pg_type where typname = 'sim_form_factor') then
    create type sim_form_factor as enum (
      'consumer_removable',
      'industrial_removable',
      'consumer_embedded',
      'industrial_embedded'
    );
  end if;

  -- from 0024
  if not exists (select 1 from pg_type where typname = 'provisioning_status') then
    create type provisioning_status as enum (
      'PROVISIONING_IN_PROGRESS',
      'ACTIVE',
      'PROVISIONING_FAILED',
      'SCHEDULED_ON_SUPPLIER',
      'SCHEDULED_LOCALLY'
    );
  end if;
end $$;

-- ============================================================
-- Tables
-- ============================================================

create table if not exists suppliers (
  supplier_id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'ACTIVE',
  created_at timestamptz not null default current_timestamp
);

-- carriers table (carrier_id kept for legacy FK references; will be renamed to public_infos in V004)
create table if not exists carriers (
  carrier_id uuid primary key default gen_random_uuid(),
  mcc char(3) not null,
  mnc char(3) not null,
  name text,
  unique (mcc, mnc)
);

create table if not exists supplier_carriers (
  supplier_id uuid not null references suppliers(supplier_id),
  carrier_id uuid not null references carriers(carrier_id),
  primary key (supplier_id, carrier_id)
);

create table if not exists tenants (
  tenant_id uuid primary key default gen_random_uuid(),
  parent_id uuid references tenants(tenant_id) on delete cascade,
  tenant_type tenant_type not null,
  code text unique,
  name text not null,
  enterprise_status enterprise_status,
  auto_suspend_enabled boolean not null default true,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create index if not exists idx_tenants_parent on tenants(parent_id);
create index if not exists idx_tenants_type on tenants(tenant_type);

create table if not exists users (
  user_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(tenant_id),
  email text,
  display_name text,
  status text not null default 'ACTIVE',
  created_at timestamptz not null default current_timestamp,
  unique (tenant_id, email)
);

create table if not exists user_roles (
  user_id uuid not null references users(user_id),
  role_name text not null,
  primary key (user_id, role_name)
);

create table if not exists enterprise_user_departments (
  user_id uuid not null references users(user_id),
  enterprise_id uuid not null references tenants(tenant_id),
  department_id uuid not null references tenants(tenant_id),
  created_at timestamptz not null default current_timestamp,
  primary key (user_id, department_id)
);

create index if not exists idx_enterprise_user_departments_enterprise on enterprise_user_departments(enterprise_id);
create index if not exists idx_enterprise_user_departments_department on enterprise_user_departments(department_id);

create table if not exists audit_logs (
  audit_id bigserial primary key,
  actor_user_id uuid,
  actor_role text,
  tenant_id uuid,
  action text not null,
  target_type text,
  target_id text,
  before_data jsonb,
  after_data jsonb,
  request_id text,
  source_ip inet,
  created_at timestamptz not null default current_timestamp
);

-- jobs: merged payload(0016), reseller_id/customer_id/idempotency_key/file_hash(0028)
create table if not exists jobs (
  job_id uuid primary key default gen_random_uuid(),
  job_type text not null,
  status job_status not null default 'QUEUED',
  progress_processed bigint not null default 0,
  progress_total bigint not null default 0,
  error_summary text,
  request_id text,
  actor_user_id uuid,
  payload jsonb,
  reseller_id uuid references tenants(tenant_id),
  customer_id uuid references tenants(tenant_id),
  idempotency_key text,
  file_hash text,
  created_at timestamptz not null default current_timestamp,
  started_at timestamptz,
  finished_at timestamptz
);

create table if not exists events (
  event_id uuid primary key default gen_random_uuid(),
  event_type text not null,
  occurred_at timestamptz not null,
  tenant_id uuid,
  actor_user_id uuid,
  request_id text,
  job_id uuid,
  payload jsonb not null
);

create index if not exists idx_events_type_time on events(event_type, occurred_at);
create index if not exists idx_events_tenant_time on events(tenant_id, occurred_at);

-- sims: merged upstream_status/upstream_info(0018→0026), imsi_secondary/form_factor/activation_code/upstream_status_updated_at(0026)
-- carrier_id nullable (absorbed 0045)
create table if not exists sims (
  sim_id uuid primary key default gen_random_uuid(),
  iccid text not null unique,
  primary_imsi text not null,
  msisdn text,
  supplier_id uuid not null references suppliers(supplier_id),
  carrier_id uuid references carriers(carrier_id),
  enterprise_id uuid references tenants(tenant_id),
  department_id uuid references tenants(tenant_id),
  status sim_status not null default 'INVENTORY',
  apn text,
  bound_imei text,
  activation_date timestamptz,
  last_status_change_at timestamptz,
  imsi_secondary_1 text,
  imsi_secondary_2 text,
  imsi_secondary_3 text,
  form_factor sim_form_factor default 'consumer_removable',
  activation_code text,
  upstream_status text,
  upstream_info jsonb,
  upstream_status_updated_at timestamptz,
  created_at timestamptz not null default current_timestamp
);

create index if not exists idx_sims_enterprise_status on sims(enterprise_id, status);

create table if not exists sim_state_history (
  history_id bigserial primary key,
  sim_id uuid not null references sims(sim_id),
  before_status sim_status,
  after_status sim_status not null,
  start_time timestamptz not null,
  end_time timestamptz,
  source text not null,
  request_id text,
  occurred_at timestamptz not null default current_timestamp
);

create index if not exists idx_sim_state_history_sim_time on sim_state_history(sim_id, start_time);

create table if not exists price_plans (
  price_plan_id uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null references tenants(tenant_id),
  name text not null,
  type price_plan_type not null,
  service_type service_type not null default 'DATA',
  currency text not null,
  billing_cycle_type billing_cycle_type not null default 'CALENDAR_MONTH',
  first_cycle_proration first_cycle_proration not null default 'NONE',
  created_at timestamptz not null default current_timestamp
);

create table if not exists price_plan_versions (
  price_plan_version_id uuid primary key default gen_random_uuid(),
  price_plan_id uuid not null references price_plans(price_plan_id),
  version int not null,
  effective_from timestamptz,
  monthly_fee numeric(12, 2) not null default 0,
  deactivated_monthly_fee numeric(12, 2) not null default 0,
  one_time_fee numeric(12, 2),
  quota_kb bigint,
  validity_days int,
  per_sim_quota_kb bigint,
  total_quota_kb bigint,
  overage_rate_per_kb numeric(18, 8),
  tiers jsonb,
  payg_rates jsonb,
  created_at timestamptz not null default current_timestamp,
  unique (price_plan_id, version)
);

create table if not exists packages (
  package_id uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null references tenants(tenant_id),
  name text not null,
  created_at timestamptz not null default current_timestamp
);

-- package_versions: carrier_id nullable (absorbed 0045)
create table if not exists package_versions (
  package_version_id uuid primary key default gen_random_uuid(),
  package_id uuid not null references packages(package_id),
  version int not null,
  status text not null default 'DRAFT',
  effective_from timestamptz,
  supplier_id uuid not null references suppliers(supplier_id),
  carrier_id uuid references carriers(carrier_id),
  service_type service_type not null default 'DATA',
  apn text,
  roaming_profile jsonb,
  throttling_policy jsonb,
  control_policy jsonb,
  commercial_terms jsonb,
  price_plan_version_id uuid not null references price_plan_versions(price_plan_version_id),
  created_at timestamptz not null default current_timestamp,
  unique (package_id, version)
);

alter table if exists package_versions
  add column if not exists price_plan_version_id uuid references price_plan_versions(price_plan_version_id),
  add column if not exists carrier_id uuid,
  add column if not exists service_type service_type not null default 'DATA',
  add column if not exists apn text,
  add column if not exists roaming_profile jsonb,
  add column if not exists throttling_policy jsonb,
  add column if not exists control_policy jsonb,
  add column if not exists commercial_terms jsonb;

create table if not exists subscriptions (
  subscription_id uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null references tenants(tenant_id),
  sim_id uuid not null references sims(sim_id),
  subscription_kind subscription_kind not null default 'MAIN',
  package_version_id uuid not null references package_versions(package_version_id),
  state subscription_state not null default 'ACTIVE',
  effective_at timestamptz not null,
  expires_at timestamptz,
  cancelled_at timestamptz,
  first_subscribed_at timestamptz,
  commitment_end_at timestamptz,
  created_at timestamptz not null default current_timestamp,
  constraint subscriptions_effective_before_expiry check (expires_at is null or effective_at <= expires_at)
);

create index if not exists idx_subscriptions_sim_effective on subscriptions(sim_id, effective_at);
create index if not exists idx_subscriptions_enterprise_state on subscriptions(enterprise_id, state);

create table if not exists cdr_files (
  cdr_file_id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(supplier_id),
  file_name text not null,
  checksum text,
  row_count bigint,
  source_time_zone text,
  period_start timestamptz,
  period_end timestamptz,
  received_at timestamptz,
  ingested_at timestamptz,
  status text not null default 'RECEIVED',
  unique (supplier_id, file_name)
);

create table if not exists usage_daily_summary (
  usage_id bigserial primary key,
  supplier_id uuid not null references suppliers(supplier_id),
  enterprise_id uuid references tenants(tenant_id),
  sim_id uuid references sims(sim_id),
  iccid text not null,
  usage_day date not null,
  visited_mccmnc text not null,
  uplink_kb bigint not null default 0,
  downlink_kb bigint not null default 0,
  total_kb bigint not null default 0,
  apn text,
  rat text,
  input_ref text,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (iccid, usage_day, visited_mccmnc)
);

create index if not exists idx_usage_enterprise_day on usage_daily_summary(enterprise_id, usage_day);
create index if not exists idx_usage_sim_day on usage_daily_summary(sim_id, usage_day);

-- bills: merged reseller_id/payment_ref/overdue_at(0027)
create table if not exists bills (
  bill_id uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null references tenants(tenant_id),
  period_start date not null,
  period_end date not null,
  status bill_status not null default 'GENERATED',
  currency text not null,
  total_amount numeric(12, 2) not null default 0,
  due_date date,
  generated_at timestamptz,
  published_at timestamptz,
  paid_at timestamptz,
  reseller_id uuid references tenants(tenant_id),
  payment_ref text,
  overdue_at timestamptz,
  created_at timestamptz not null default current_timestamp,
  unique (enterprise_id, period_start, period_end),
  constraint bills_period_order check (period_start <= period_end)
);

create index if not exists idx_bills_status_due on bills(status, due_date);
create index if not exists idx_bills_reseller on bills(reseller_id);

-- bill_line_items: merged group_key/group_type/group_subtotal(0027)
create table if not exists bill_line_items (
  line_item_id bigserial primary key,
  bill_id uuid not null references bills(bill_id),
  item_type text not null,
  sim_id uuid,
  package_version_id uuid,
  amount numeric(12, 2) not null,
  metadata jsonb,
  group_key text,
  group_type text,
  group_subtotal numeric(12, 2),
  created_at timestamptz not null default current_timestamp
);

create table if not exists adjustment_notes (
  note_id uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null references tenants(tenant_id),
  note_type note_type not null,
  status note_status not null default 'DRAFT',
  currency text not null,
  total_amount numeric(12, 2) not null default 0,
  reason text,
  input_ref text,
  calculation_id text,
  created_at timestamptz not null default current_timestamp
);

create table if not exists adjustment_note_items (
  note_item_id bigserial primary key,
  note_id uuid not null references adjustment_notes(note_id),
  item_type text not null,
  sim_id uuid,
  amount numeric(12, 2) not null,
  metadata jsonb,
  created_at timestamptz not null default current_timestamp
);

-- rating_results: merged rule_version_id(0008)
create table if not exists rating_results (
  rating_result_id uuid primary key default gen_random_uuid(),
  calculation_id text not null,
  enterprise_id uuid references tenants(tenant_id),
  sim_id uuid references sims(sim_id),
  iccid text,
  usage_day date,
  visited_mccmnc text,
  input_ref text,
  matched_subscription_id uuid references subscriptions(subscription_id),
  matched_package_version_id uuid references package_versions(package_version_id),
  matched_price_plan_version_id uuid references price_plan_versions(price_plan_version_id),
  classification text not null,
  charged_kb bigint,
  rate_per_kb numeric(18, 8),
  amount numeric(12, 2) not null default 0,
  currency text,
  rule_version_id uuid,
  created_at timestamptz not null default current_timestamp
);

create index if not exists idx_rating_results_calc on rating_results(calculation_id);
create index if not exists idx_rating_results_enterprise_day on rating_results(enterprise_id, usage_day);

-- share_links (from 0014+0015): kind constraint includes 'bills'
create table if not exists share_links (
  code text primary key,
  kind text not null,
  params jsonb not null,
  tenant_id uuid not null,
  enterprise_id uuid generated always as (tenant_id) stored,
  visibility text not null default 'tenant',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by_role text not null default 'ENTERPRISE',
  request_id text null,
  constraint share_links_code_format check (code ~ '^[A-Za-z0-9]{8}$'),
  constraint share_links_kind check (kind in ('packages','packageVersions','bills')),
  constraint share_links_visibility check (visibility in ('tenant','public')),
  constraint share_links_params_object check (jsonb_typeof(params) = 'object')
);

create index if not exists idx_share_links_tenant_id on share_links(tenant_id);
create index if not exists idx_share_links_enterprise_id on share_links(enterprise_id);
create index if not exists idx_share_links_expires_at on share_links(expires_at);
create index if not exists idx_share_links_created_at on share_links(created_at);
create index if not exists idx_share_links_kind on share_links(kind);
create index if not exists idx_share_links_request_id on share_links(request_id);

-- vendor_product_mappings (from 0023)
create table if not exists vendor_product_mappings (
  mapping_id uuid primary key default gen_random_uuid(),
  package_version_id uuid not null references package_versions(package_version_id),
  supplier_id uuid not null references suppliers(supplier_id),
  external_product_id text not null,
  provisioning_parameters jsonb,
  created_at timestamptz not null default current_timestamp,
  unique (package_version_id, supplier_id)
);

-- provisioning_orders (from 0024)
create table if not exists provisioning_orders (
  order_id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(subscription_id),
  supplier_id uuid not null references suppliers(supplier_id),
  sim_id uuid not null references sims(sim_id),
  action text not null,
  provisioning_status provisioning_status not null default 'PROVISIONING_IN_PROGRESS',
  idempotency_key text not null unique,
  scheduled_at timestamptz,
  attempted_at timestamptz,
  completed_at timestamptz,
  retry_count int not null default 0,
  error_detail text,
  metadata jsonb,
  created_at timestamptz not null default current_timestamp
);

create index if not exists idx_provisioning_orders_status
  on provisioning_orders(provisioning_status, scheduled_at);

-- reconciliation_runs (from 0025)
create table if not exists reconciliation_runs (
  run_id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(supplier_id),
  run_date date not null,
  scope text not null default 'INCREMENTAL',
  total_checked bigint not null default 0,
  matched bigint not null default 0,
  mismatches bigint not null default 0,
  local_only bigint not null default 0,
  upstream_only bigint not null default 0,
  mismatch_details jsonb,
  status text not null default 'RUNNING',
  started_at timestamptz not null default current_timestamp,
  finished_at timestamptz,
  unique (supplier_id, run_date)
);

-- api_clients (from api_clients.sql, RLS moved to V007)
create table if not exists api_clients (
  api_client_id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  secret_hash text not null,
  enterprise_id uuid not null references tenants(tenant_id),
  status text not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  rotated_at timestamptz null
);

-- Additional indexes from 0029
create index if not exists idx_audit_actor_time on audit_logs(actor_user_id, created_at);
