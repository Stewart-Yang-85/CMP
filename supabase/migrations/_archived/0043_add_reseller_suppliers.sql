create table if not exists reseller_suppliers (
  reseller_id uuid not null references resellers(id),
  supplier_id uuid not null references suppliers(supplier_id),
  created_at timestamptz not null default current_timestamp,
  primary key (reseller_id, supplier_id)
);

create index if not exists idx_reseller_suppliers_supplier on reseller_suppliers(supplier_id);
