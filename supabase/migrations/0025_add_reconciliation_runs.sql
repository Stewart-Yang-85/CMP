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
