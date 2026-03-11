do $$
begin
  if not exists (select 1 from pg_type where typname = 'alert_type') then
    create type alert_type as enum ('POOL_USAGE_HIGH', 'OUT_OF_PROFILE_SURGE', 'SILENT_SIM', 'UNEXPECTED_ROAMING', 'CDR_DELAY', 'UPSTREAM_DISCONNECT');
  end if;
  if not exists (select 1 from pg_type where typname = 'alert_severity') then
    create type alert_severity as enum ('P0', 'P1', 'P2', 'P3');
  end if;
  if not exists (select 1 from pg_type where typname = 'alert_status') then
    create type alert_status as enum ('OPEN', 'ACKED', 'RESOLVED', 'SUPPRESSED');
  end if;
end $$;

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
