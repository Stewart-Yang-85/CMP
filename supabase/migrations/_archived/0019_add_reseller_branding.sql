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
