begin;

create table if not exists business_operators (
  operator_id uuid primary key default gen_random_uuid(),
  mcc char(3) not null,
  mnc char(3) not null,
  name text not null
);

insert into business_operators (operator_id, mcc, mnc, name)
values ('1413a2b1-8888-4e5a-9a66-949ca1f56d72', '204', '08', 'TATA')
on conflict (operator_id) do nothing;

create table if not exists operators (
  operator_id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(supplier_id),
  carrier_id uuid not null references carriers(carrier_id),
  name text,
  status text not null default 'ACTIVE',
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (supplier_id, carrier_id)
);

insert into operators (supplier_id, carrier_id, name)
select sc.supplier_id, sc.carrier_id, c.name
from supplier_carriers sc
join carriers c on c.carrier_id = sc.carrier_id
left join operators o on o.supplier_id = sc.supplier_id and o.carrier_id = sc.carrier_id
where o.operator_id is null;

alter table if exists apn_profiles
  add column if not exists operator_id uuid references operators(operator_id);

alter table if exists roaming_profiles
  add column if not exists operator_id uuid references operators(operator_id);

alter table if exists package_versions
  add column if not exists operator_id uuid references operators(operator_id);

alter table if exists sims
  add column if not exists operator_id uuid references operators(operator_id);

update apn_profiles
set operator_id = o.operator_id
from operators o
where apn_profiles.operator_id is null
  and apn_profiles.supplier_id = o.supplier_id
  and apn_profiles.carrier_id = o.carrier_id;

update roaming_profiles
set operator_id = o.operator_id
from operators o
where roaming_profiles.operator_id is null
  and roaming_profiles.supplier_id = o.supplier_id
  and roaming_profiles.carrier_id = o.carrier_id;

update package_versions
set operator_id = o.operator_id
from operators o
where package_versions.operator_id is null
  and package_versions.supplier_id = o.supplier_id
  and package_versions.carrier_id = o.carrier_id;

update sims
set operator_id = o.operator_id
from operators o
where sims.operator_id is null
  and sims.supplier_id = o.supplier_id
  and sims.carrier_id = o.carrier_id;

commit;
