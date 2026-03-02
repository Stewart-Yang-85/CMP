alter table jobs
  add column if not exists reseller_id uuid references tenants(tenant_id),
  add column if not exists customer_id uuid references tenants(tenant_id),
  add column if not exists idempotency_key text,
  add column if not exists file_hash text;
