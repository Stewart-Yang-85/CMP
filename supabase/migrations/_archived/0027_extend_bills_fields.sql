alter table bills
  add column if not exists reseller_id uuid references tenants(tenant_id),
  add column if not exists payment_ref text,
  add column if not exists overdue_at timestamptz;

alter table bill_line_items
  add column if not exists group_key text,
  add column if not exists group_type text,
  add column if not exists group_subtotal numeric(12,2);
