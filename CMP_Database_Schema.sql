CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tenant_type') THEN
    CREATE TYPE tenant_type AS ENUM ('RESELLER', 'ENTERPRISE', 'DEPARTMENT');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enterprise_status') THEN
    CREATE TYPE enterprise_status AS ENUM ('ACTIVE', 'SUSPENDED', 'INACTIVE');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sim_status') THEN
    CREATE TYPE sim_status AS ENUM ('INVENTORY', 'TEST_READY', 'ACTIVATED', 'DEACTIVATED', 'RETIRED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_state') THEN
    CREATE TYPE subscription_state AS ENUM ('PENDING', 'ACTIVE', 'CANCELLED', 'EXPIRED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status') THEN
    CREATE TYPE job_status AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bill_status') THEN
    CREATE TYPE bill_status AS ENUM ('GENERATED', 'PUBLISHED', 'PAID', 'OVERDUE', 'WRITTEN_OFF');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'service_type') THEN
    CREATE TYPE service_type AS ENUM ('DATA', 'VOICE', 'SMS');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_cycle_type') THEN
    CREATE TYPE billing_cycle_type AS ENUM ('CALENDAR_MONTH', 'CUSTOM_RANGE');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'first_cycle_proration') THEN
    CREATE TYPE first_cycle_proration AS ENUM ('NONE', 'DAILY_PRORATION');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'price_plan_type') THEN
    CREATE TYPE price_plan_type AS ENUM ('ONE_TIME', 'SIM_DEPENDENT_BUNDLE', 'FIXED_BUNDLE', 'TIERED_VOLUME_PRICING');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'note_type') THEN
    CREATE TYPE note_type AS ENUM ('CREDIT', 'DEBIT');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'note_status') THEN
    CREATE TYPE note_status AS ENUM ('DRAFT', 'APPROVED', 'APPLIED', 'CANCELLED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_kind') THEN
    CREATE TYPE subscription_kind AS ENUM ('MAIN', 'ADD_ON');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS suppliers (
  supplier_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS carriers (
  carrier_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mcc CHAR(3) NOT NULL,
  mnc CHAR(3) NOT NULL,
  name TEXT,
  UNIQUE (mcc, mnc)
);

CREATE TABLE IF NOT EXISTS supplier_carriers (
  supplier_id UUID NOT NULL REFERENCES suppliers(supplier_id),
  carrier_id UUID NOT NULL REFERENCES carriers(carrier_id),
  PRIMARY KEY (supplier_id, carrier_id)
);

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id UUID REFERENCES tenants(tenant_id),
  tenant_type tenant_type NOT NULL,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  enterprise_status enterprise_status,
  auto_suspend_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenants_parent ON tenants(parent_id);
CREATE INDEX IF NOT EXISTS idx_tenants_type ON tenants(tenant_type);

CREATE TABLE IF NOT EXISTS users (
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(tenant_id),
  email TEXT,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID NOT NULL REFERENCES users(user_id),
  role_name TEXT NOT NULL,
  PRIMARY KEY (user_id, role_name)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id BIGSERIAL PRIMARY KEY,
  actor_user_id UUID,
  actor_role TEXT,
  tenant_id UUID,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  before_data JSONB,
  after_data JSONB,
  request_id TEXT,
  source_ip INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL,
  status job_status NOT NULL DEFAULT 'QUEUED',
  payload JSONB,
  progress_processed BIGINT NOT NULL DEFAULT 0,
  progress_total BIGINT NOT NULL DEFAULT 0,
  error_summary TEXT,
  request_id TEXT,
  actor_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  tenant_id UUID,
  actor_user_id UUID,
  request_id TEXT,
  job_id UUID,
  payload JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(event_type, occurred_at);

CREATE TABLE IF NOT EXISTS sims (
  sim_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  iccid TEXT NOT NULL UNIQUE,
  primary_imsi TEXT NOT NULL,
  msisdn TEXT,
  supplier_id UUID NOT NULL REFERENCES suppliers(supplier_id),
  carrier_id UUID NOT NULL REFERENCES carriers(carrier_id),
  enterprise_id UUID REFERENCES tenants(tenant_id),
  department_id UUID REFERENCES tenants(tenant_id),
  status sim_status NOT NULL DEFAULT 'INVENTORY',
  apn TEXT,
  bound_imei TEXT,
  activation_date TIMESTAMPTZ,
  last_status_change_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sims_enterprise_status ON sims(enterprise_id, status);

CREATE TABLE IF NOT EXISTS sim_state_history (
  history_id BIGSERIAL PRIMARY KEY,
  sim_id UUID NOT NULL REFERENCES sims(sim_id),
  before_status sim_status,
  after_status sim_status NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  source TEXT NOT NULL,
  request_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sim_state_history_sim_time ON sim_state_history(sim_id, start_time);

CREATE TABLE IF NOT EXISTS price_plans (
  price_plan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id UUID NOT NULL REFERENCES tenants(tenant_id),
  name TEXT NOT NULL,
  type price_plan_type NOT NULL,
  service_type service_type NOT NULL DEFAULT 'DATA',
  currency TEXT NOT NULL,
  billing_cycle_type billing_cycle_type NOT NULL DEFAULT 'CALENDAR_MONTH',
  first_cycle_proration first_cycle_proration NOT NULL DEFAULT 'NONE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS price_plan_versions (
  price_plan_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  price_plan_id UUID NOT NULL REFERENCES price_plans(price_plan_id),
  version INT NOT NULL,
  effective_from TIMESTAMPTZ,
  monthly_fee NUMERIC(12, 2) NOT NULL DEFAULT 0,
  deactivated_monthly_fee NUMERIC(12, 2) NOT NULL DEFAULT 0,
  one_time_fee NUMERIC(12, 2),
  quota_kb BIGINT,
  validity_days INT,
  per_sim_quota_kb BIGINT,
  total_quota_kb BIGINT,
  overage_rate_per_kb NUMERIC(18, 8),
  tiers JSONB,
  payg_rates JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (price_plan_id, version)
);

CREATE TABLE IF NOT EXISTS packages (
  package_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id UUID NOT NULL REFERENCES tenants(tenant_id),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS package_versions (
  package_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL REFERENCES packages(package_id),
  version INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  effective_from TIMESTAMPTZ,
  supplier_id UUID NOT NULL REFERENCES suppliers(supplier_id),
  carrier_id UUID NOT NULL REFERENCES carriers(carrier_id),
  service_type service_type NOT NULL DEFAULT 'DATA',
  apn TEXT,
  roaming_profile JSONB,
  throttling_policy JSONB,
  control_policy JSONB,
  commercial_terms JSONB,
  price_plan_version_id UUID NOT NULL REFERENCES price_plan_versions(price_plan_version_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (package_id, version)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id UUID NOT NULL REFERENCES tenants(tenant_id),
  sim_id UUID NOT NULL REFERENCES sims(sim_id),
  subscription_kind subscription_kind NOT NULL DEFAULT 'MAIN',
  package_version_id UUID NOT NULL REFERENCES package_versions(package_version_id),
  state subscription_state NOT NULL DEFAULT 'ACTIVE',
  effective_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  first_subscribed_at TIMESTAMPTZ,
  commitment_end_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_sim_effective ON subscriptions(sim_id, effective_at);

CREATE TABLE IF NOT EXISTS cdr_files (
  cdr_file_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers(supplier_id),
  file_name TEXT NOT NULL,
  checksum TEXT,
  row_count BIGINT,
  source_time_zone TEXT,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  ingested_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'RECEIVED',
  UNIQUE (supplier_id, file_name)
);

CREATE TABLE IF NOT EXISTS usage_daily_summary (
  usage_id BIGSERIAL PRIMARY KEY,
  supplier_id UUID NOT NULL REFERENCES suppliers(supplier_id),
  enterprise_id UUID REFERENCES tenants(tenant_id),
  sim_id UUID REFERENCES sims(sim_id),
  iccid TEXT NOT NULL,
  usage_day DATE NOT NULL,
  visited_mccmnc TEXT NOT NULL,
  uplink_kb BIGINT NOT NULL DEFAULT 0,
  downlink_kb BIGINT NOT NULL DEFAULT 0,
  total_kb BIGINT NOT NULL DEFAULT 0,
  apn TEXT,
  rat TEXT,
  input_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (iccid, usage_day, visited_mccmnc)
);

CREATE INDEX IF NOT EXISTS idx_usage_enterprise_day ON usage_daily_summary(enterprise_id, usage_day);

CREATE TABLE IF NOT EXISTS bills (
  bill_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id UUID NOT NULL REFERENCES tenants(tenant_id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status bill_status NOT NULL DEFAULT 'GENERATED',
  currency TEXT NOT NULL,
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  due_date DATE,
  generated_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (enterprise_id, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS bill_line_items (
  line_item_id BIGSERIAL PRIMARY KEY,
  bill_id UUID NOT NULL REFERENCES bills(bill_id),
  item_type TEXT NOT NULL,
  sim_id UUID,
  package_version_id UUID,
  amount NUMERIC(12, 2) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS adjustment_notes (
  note_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id UUID NOT NULL REFERENCES tenants(tenant_id),
  note_type note_type NOT NULL,
  status note_status NOT NULL DEFAULT 'DRAFT',
  currency TEXT NOT NULL,
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  reason TEXT,
  input_ref TEXT,
  calculation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS adjustment_note_items (
  note_item_id BIGSERIAL PRIMARY KEY,
  note_id UUID NOT NULL REFERENCES adjustment_notes(note_id),
  item_type TEXT NOT NULL,
  sim_id UUID,
  amount NUMERIC(12, 2) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rating_results (
  rating_result_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calculation_id TEXT NOT NULL,
  enterprise_id UUID REFERENCES tenants(tenant_id),
  sim_id UUID REFERENCES sims(sim_id),
  iccid TEXT,
  usage_day DATE,
  visited_mccmnc TEXT,
  input_ref TEXT,
  matched_subscription_id UUID REFERENCES subscriptions(subscription_id),
  matched_package_version_id UUID REFERENCES package_versions(package_version_id),
  matched_price_plan_version_id UUID REFERENCES price_plan_versions(price_plan_version_id),
  classification TEXT NOT NULL,
  charged_kb BIGINT,
  rate_per_kb NUMERIC(18, 8),
  amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rating_results_calc ON rating_results(calculation_id);
CREATE INDEX IF NOT EXISTS idx_rating_results_enterprise_day ON rating_results(enterprise_id, usage_day);
