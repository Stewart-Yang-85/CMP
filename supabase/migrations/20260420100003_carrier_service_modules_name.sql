-- Human-readable label for carrier service modules (lists, UI).

alter table carrier_service_modules
  add column if not exists name text;

update carrier_service_modules
set name = 'Carrier service ' || carrier_service_id::text
where name is null or btrim(coalesce(name, '')) = '';

alter table carrier_service_modules
  alter column name set not null;

comment on column carrier_service_modules.name is 'Display name; required on create; non-empty string.';
