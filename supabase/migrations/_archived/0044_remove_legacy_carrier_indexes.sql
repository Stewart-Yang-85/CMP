begin;

alter table if exists operators
  drop constraint if exists operators_supplier_id_carrier_id_key;

drop index if exists idx_operators_supplier_carrier_unique;

create unique index if not exists idx_operators_supplier_business_operator_unique
  on operators(supplier_id, business_operator_id)
  where business_operator_id is not null;

create index if not exists idx_sims_operator_id on sims(operator_id);
create index if not exists idx_package_versions_operator_id on package_versions(operator_id);
create index if not exists idx_apn_profiles_operator_id on apn_profiles(operator_id);
create index if not exists idx_roaming_profiles_operator_id on roaming_profiles(operator_id);

commit;
