create table if not exists vendor_product_mappings (
  mapping_id uuid primary key default gen_random_uuid(),
  package_version_id uuid not null references package_versions(package_version_id),
  supplier_id uuid not null references suppliers(supplier_id),
  external_product_id text not null,
  provisioning_parameters jsonb,
  created_at timestamptz not null default current_timestamp,
  unique (package_version_id, supplier_id)
);
