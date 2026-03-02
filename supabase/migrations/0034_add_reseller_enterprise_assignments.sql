create table if not exists reseller_enterprise_assignments (
  user_id uuid not null references users(user_id),
  reseller_id uuid not null references tenants(tenant_id),
  enterprise_id uuid not null references tenants(tenant_id),
  created_at timestamptz not null default current_timestamp,
  primary key (user_id, enterprise_id)
);

create index if not exists idx_reseller_assignments_reseller on reseller_enterprise_assignments(reseller_id);
create index if not exists idx_reseller_assignments_enterprise on reseller_enterprise_assignments(enterprise_id);
