alter table if exists customers
  add column if not exists api_key text,
  add column if not exists api_secret_hash bytea,
  add column if not exists webhook_url text;

do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'customers'
  ) then
    create unique index if not exists idx_customers_api_key on customers(api_key);
  end if;
end $$;
