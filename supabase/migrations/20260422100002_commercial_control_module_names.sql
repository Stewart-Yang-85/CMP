-- Display names for commercial terms and control policy modules (aligned with carrier_service_modules.name).

alter table commercial_terms_modules
  add column if not exists name text;

update commercial_terms_modules
set name = 'Commercial terms ' || commercial_terms_id::text
where name is null or btrim(coalesce(name, '')) = '';

alter table commercial_terms_modules
  alter column name set not null;

comment on column commercial_terms_modules.name is 'Display name; required on create; non-empty string.';

alter table control_policy_modules
  add column if not exists name text;

update control_policy_modules
set name = 'Control policy ' || control_policy_id::text
where name is null or btrim(coalesce(name, '')) = '';

alter table control_policy_modules
  alter column name set not null;

comment on column control_policy_modules.name is 'Display name; required on create; non-empty string.';
