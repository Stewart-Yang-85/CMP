begin;

do $$
begin
  if to_regclass('public.public_infos') is not null then
    execute 'alter table public.public_infos add column if not exists country_name text';
    execute 'alter table public.public_infos add column if not exists lte_bands text';
  elsif exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'carriers'
      and c.relkind = 'r'
  ) then
    execute 'alter table public.carriers add column if not exists country_name text';
    execute 'alter table public.carriers add column if not exists lte_bands text';
  end if;
end $$;

commit;
