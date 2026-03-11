begin;

alter table if exists operators
  add column if not exists business_operator_id uuid references business_operators(operator_id);

update operators o
set business_operator_id = bo.operator_id
from carriers c
join business_operators bo on bo.mcc = c.mcc and bo.mnc = c.mnc
where o.business_operator_id is null
  and o.carrier_id = c.carrier_id;

alter table if exists operators
  alter column carrier_id drop not null;

create unique index if not exists idx_operators_supplier_business_operator_unique
  on operators(supplier_id, business_operator_id)
  where business_operator_id is not null;

commit;
