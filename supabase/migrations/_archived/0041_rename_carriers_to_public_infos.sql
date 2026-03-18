begin;

do $$
begin
  if to_regclass('public.carriers') is not null and to_regclass('public.public_infos') is null then
    execute 'alter table public.carriers rename to public_infos';
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'public_infos' and column_name = 'carrier_id'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'public_infos' and column_name = 'public_info_id'
  ) then
    execute 'alter table public.public_infos rename column carrier_id to public_info_id';
  end if;
end $$;

drop view if exists public.carriers;

do $$
begin
  if to_regclass('public.public_infos') is not null then
    execute 'create view public.carriers as select public_info_id as carrier_id, mcc, mnc, name, country_name, lte_bands from public.public_infos';
  end if;
end $$;

commit;
