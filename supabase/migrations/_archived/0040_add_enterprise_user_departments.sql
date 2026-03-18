create table if not exists enterprise_user_departments (
  user_id uuid not null references users(user_id),
  enterprise_id uuid not null references tenants(tenant_id),
  department_id uuid not null references tenants(tenant_id),
  created_at timestamptz not null default current_timestamp,
  primary key (user_id, department_id)
);

create index if not exists idx_enterprise_user_departments_enterprise on enterprise_user_departments(enterprise_id);
create index if not exists idx_enterprise_user_departments_department on enterprise_user_departments(department_id);
