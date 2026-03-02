do $$
begin
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
