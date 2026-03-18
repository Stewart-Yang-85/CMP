alter table if exists bills enable row level security;
alter table if exists bill_line_items enable row level security;

drop policy if exists bills_select_golden_anon on bills;
create policy bills_select_golden_anon
on bills
for select
to anon
using (
  enterprise_id in (select tenant_id from tenants where code = 'ENT_GOLDEN')
);

drop policy if exists bills_select_golden_authenticated on bills;
create policy bills_select_golden_authenticated
on bills
for select
to authenticated
using (
  enterprise_id in (select tenant_id from tenants where code = 'ENT_GOLDEN')
);

drop policy if exists bill_line_items_select_golden_anon on bill_line_items;
create policy bill_line_items_select_golden_anon
on bill_line_items
for select
to anon
using (
  exists (
    select 1
    from bills b
    where b.bill_id = bill_line_items.bill_id
      and b.enterprise_id in (select tenant_id from tenants where code = 'ENT_GOLDEN')
  )
);

drop policy if exists bill_line_items_select_golden_authenticated on bill_line_items;
create policy bill_line_items_select_golden_authenticated
on bill_line_items
for select
to authenticated
using (
  exists (
    select 1
    from bills b
    where b.bill_id = bill_line_items.bill_id
      and b.enterprise_id in (select tenant_id from tenants where code = 'ENT_GOLDEN')
  )
);

