begin;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'sims'
      and column_name = 'carrier_id'
      and is_nullable = 'NO'
  ) then
    execute 'alter table public.sims alter column carrier_id drop not null';
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'package_versions'
      and column_name = 'carrier_id'
      and is_nullable = 'NO'
  ) then
    execute 'alter table public.package_versions alter column carrier_id drop not null';
  end if;
end $$;

commit;
