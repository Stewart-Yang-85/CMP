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
