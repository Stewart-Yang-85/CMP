-- V_fix_customer_status_enum.sql
-- Fixes customer_status ENUM from (ACTIVE, OVERDUE, TERMINATED)
-- to spec-required (ACTIVE, INACTIVE, SUSPENDED).
--
-- Mapping: OVERDUE -> SUSPENDED, TERMINATED -> INACTIVE
--
-- Also updates the sync trigger (sync_customer_status_to_tenant) so it
-- performs a simple 1:1 mapping now that customer_status aligns with
-- enterprise_status values.
--
-- Rollback:
--   ALTER TYPE customer_status RENAME VALUE 'SUSPENDED' TO 'OVERDUE';
--   ALTER TYPE customer_status RENAME VALUE 'INACTIVE' TO 'TERMINATED';
--   -- then re-apply V008 trigger with the old mapping

-- ============================================================
-- 1. Rename ENUM values (PostgreSQL 10+)
-- ============================================================
-- Guard each rename: only execute if the old label still exists.
-- This makes the migration idempotent (safe to re-run).

do $$
begin
  -- OVERDUE -> SUSPENDED
  if exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'customer_status'
      and e.enumlabel = 'OVERDUE'
  ) then
    execute 'alter type public.customer_status rename value ''OVERDUE'' to ''SUSPENDED''';
  end if;

  -- TERMINATED -> INACTIVE
  if exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'customer_status'
      and e.enumlabel = 'TERMINATED'
  ) then
    execute 'alter type public.customer_status rename value ''TERMINATED'' to ''INACTIVE''';
  end if;
end $$;

-- ============================================================
-- 2. Replace sync trigger: customer_status -> enterprise_status
-- ============================================================
-- Now that customer_status = (ACTIVE, INACTIVE, SUSPENDED) and
-- enterprise_status = (ACTIVE, INACTIVE, SUSPENDED), the mapping
-- is a direct 1:1 cast -- no translation needed.

create or replace function sync_customer_status_to_tenant()
returns trigger as $$
begin
  update tenants
  set enterprise_status = NEW.status::text::enterprise_status,
      auto_suspend_enabled = NEW.auto_suspend_enabled,
      updated_at = current_timestamp
  where tenant_id = NEW.tenant_id;

  return NEW;
end;
$$ language plpgsql;

-- Trigger definition is unchanged (already exists from V008), but
-- recreate to ensure it points to the updated function.
drop trigger if exists trg_sync_customer_status on customers;
create trigger trg_sync_customer_status
  after insert or update of status, auto_suspend_enabled
  on customers
  for each row
  execute function sync_customer_status_to_tenant();

-- ============================================================
-- 3. Backfill: re-sync existing customers to tenants
-- ============================================================
-- After the ENUM rename, existing rows already have the correct
-- labels. Just ensure tenants rows are in sync with a direct cast.

do $$
declare
  rec record;
begin
  for rec in
    select c.tenant_id, c.status, c.auto_suspend_enabled
    from customers c
  loop
    update tenants
    set enterprise_status = rec.status::text::enterprise_status,
        auto_suspend_enabled = rec.auto_suspend_enabled,
        updated_at = current_timestamp
    where tenant_id = rec.tenant_id
      and (enterprise_status is distinct from rec.status::text::enterprise_status
           or auto_suspend_enabled is distinct from rec.auto_suspend_enabled);
  end loop;
end $$;
