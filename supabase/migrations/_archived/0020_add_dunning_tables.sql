do $$
begin
  if not exists (select 1 from pg_type where typname = 'dunning_status') then
    create type dunning_status as enum ('NORMAL', 'OVERDUE_WARNING', 'SUSPENDED', 'SERVICE_INTERRUPTED');
  end if;
end $$;

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

create table if not exists dunning_actions (
  action_id bigserial primary key,
  dunning_id uuid not null references dunning_records(dunning_id),
  action_type text not null,
  channel text,
  delivery_status text,
  metadata jsonb,
  created_at timestamptz not null default current_timestamp
);
