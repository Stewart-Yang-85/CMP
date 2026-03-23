-- Align legacy lowercase reseller_status labels (archived 0035) with V003 / V008 uppercase.
-- Safe to run on DBs that already use uppercase (each RENAME is skipped if source label missing).

do $$
begin
  if exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'reseller_status' and e.enumlabel = 'active'
  ) then
    execute 'alter type public.reseller_status rename value ''active'' to ''ACTIVE''';
  end if;

  if exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'reseller_status' and e.enumlabel = 'deactivated'
  ) then
    execute 'alter type public.reseller_status rename value ''deactivated'' to ''DEACTIVATED''';
  end if;

  if exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'reseller_status' and e.enumlabel = 'suspended'
  ) then
    execute 'alter type public.reseller_status rename value ''suspended'' to ''SUSPENDED''';
  end if;
end $$;
