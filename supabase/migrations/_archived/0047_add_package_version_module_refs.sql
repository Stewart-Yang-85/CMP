alter table package_versions
  add column if not exists carrier_service_id uuid references carrier_service_modules(carrier_service_id) on delete set null,
  add column if not exists carrier_service_config jsonb,
  add column if not exists control_policy_id uuid references control_policy_modules(control_policy_id) on delete set null,
  add column if not exists commercial_terms_id uuid references commercial_terms_modules(commercial_terms_id) on delete set null;

create index if not exists idx_package_versions_carrier_service_id
  on package_versions(carrier_service_id);

create index if not exists idx_package_versions_control_policy_id
  on package_versions(control_policy_id);

create index if not exists idx_package_versions_commercial_terms_id
  on package_versions(commercial_terms_id);
