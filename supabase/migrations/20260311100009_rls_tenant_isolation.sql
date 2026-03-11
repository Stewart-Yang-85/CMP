-- V009_rls_tenant_isolation.sql
-- Improve RLS policies from "allow all authenticated" to tenant-scoped isolation.
--
-- IMPORTANT: The application uses service_role key which BYPASSES RLS entirely.
-- These policies serve as defense-in-depth for the authenticated role (anon key + JWT).
-- Primary tenant isolation is enforced at the application layer (rbac.ts middleware).
--
-- Strategy:
--   1. Use request.jwt.claims to extract tenant_id from JWT
--   2. All tenant-scoped tables filter by tenant hierarchy
--   3. Service role continues to bypass RLS (correct behavior for server-side operations)
--
-- Rollback:
--   Run V007 again to restore permissive policies.

-- Helper: extract tenant_id from JWT claims (returns NULL if not present)
create or replace function auth_tenant_id()
returns uuid as $$
begin
  return coalesce(
    (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')::uuid,
    (current_setting('app.tenant_id', true))::uuid
  );
exception when others then
  return null;
end;
$$ language plpgsql stable;

-- Helper: check if a tenant_id is accessible to the current user's tenant
-- (direct match OR parent-child relationship)
create or replace function is_tenant_accessible(check_tenant_id uuid)
returns boolean as $$
declare
  my_tenant uuid;
begin
  my_tenant := auth_tenant_id();
  if my_tenant is null then return false; end if;
  if check_tenant_id = my_tenant then return true; end if;
  -- Check if check_tenant_id is a child of my_tenant
  return exists (
    select 1 from tenants
    where tenant_id = check_tenant_id and parent_id = my_tenant
  );
end;
$$ language plpgsql stable;

-- ============================================================
-- Upgrade key tables to tenant-scoped RLS
-- ============================================================

-- sims: scope by enterprise_id
alter table if exists sims enable row level security;
drop policy if exists sims_no_anon_access on sims;
create policy sims_no_anon_access on sims for all to anon using (false) with check (false);
drop policy if exists sims_tenant_isolation on sims;
create policy sims_tenant_isolation on sims for all to authenticated
  using (is_tenant_accessible(enterprise_id))
  with check (is_tenant_accessible(enterprise_id));

-- subscriptions: scope by enterprise_id
alter table if exists subscriptions enable row level security;
drop policy if exists subscriptions_no_anon_access on subscriptions;
create policy subscriptions_no_anon_access on subscriptions for all to anon using (false) with check (false);
drop policy if exists subscriptions_tenant_isolation on subscriptions;
create policy subscriptions_tenant_isolation on subscriptions for all to authenticated
  using (is_tenant_accessible(enterprise_id))
  with check (is_tenant_accessible(enterprise_id));

-- bills: scope by enterprise_id
alter table if exists bills enable row level security;
drop policy if exists bills_no_anon_access on bills;
create policy bills_no_anon_access on bills for all to anon using (false) with check (false);
drop policy if exists bills_tenant_isolation on bills;
create policy bills_tenant_isolation on bills for all to authenticated
  using (is_tenant_accessible(enterprise_id))
  with check (is_tenant_accessible(enterprise_id));

-- usage_daily_summary: scope by enterprise_id
alter table if exists usage_daily_summary enable row level security;
drop policy if exists usage_daily_summary_no_anon_access on usage_daily_summary;
create policy usage_daily_summary_no_anon_access on usage_daily_summary for all to anon using (false) with check (false);
drop policy if exists usage_daily_summary_tenant_isolation on usage_daily_summary;
create policy usage_daily_summary_tenant_isolation on usage_daily_summary for all to authenticated
  using (is_tenant_accessible(enterprise_id))
  with check (is_tenant_accessible(enterprise_id));

-- adjustment_notes: scope by enterprise_id
alter table if exists adjustment_notes enable row level security;
drop policy if exists adjustment_notes_no_anon_access on adjustment_notes;
create policy adjustment_notes_no_anon_access on adjustment_notes for all to anon using (false) with check (false);
drop policy if exists adjustment_notes_tenant_isolation on adjustment_notes;
create policy adjustment_notes_tenant_isolation on adjustment_notes for all to authenticated
  using (is_tenant_accessible(enterprise_id))
  with check (is_tenant_accessible(enterprise_id));

-- rating_results: scope by enterprise_id
alter table if exists rating_results enable row level security;
drop policy if exists rating_results_no_anon_access on rating_results;
create policy rating_results_no_anon_access on rating_results for all to anon using (false) with check (false);
drop policy if exists rating_results_tenant_isolation on rating_results;
create policy rating_results_tenant_isolation on rating_results for all to authenticated
  using (is_tenant_accessible(enterprise_id))
  with check (is_tenant_accessible(enterprise_id));

-- users: scope by tenant_id
alter table if exists users enable row level security;
drop policy if exists users_no_anon_access on users;
create policy users_no_anon_access on users for all to anon using (false) with check (false);
drop policy if exists users_tenant_isolation on users;
create policy users_tenant_isolation on users for all to authenticated
  using (is_tenant_accessible(tenant_id))
  with check (is_tenant_accessible(tenant_id));

-- audit_logs: scope by tenant_id
alter table if exists audit_logs enable row level security;
drop policy if exists audit_logs_no_anon_access on audit_logs;
create policy audit_logs_no_anon_access on audit_logs for all to anon using (false) with check (false);
drop policy if exists audit_logs_tenant_isolation on audit_logs;
create policy audit_logs_tenant_isolation on audit_logs for all to authenticated
  using (is_tenant_accessible(tenant_id));

-- events: scope by tenant_id
alter table if exists events enable row level security;
drop policy if exists events_no_anon_access on events;
create policy events_no_anon_access on events for all to anon using (false) with check (false);
drop policy if exists events_tenant_isolation on events;
create policy events_tenant_isolation on events for all to authenticated
  using (is_tenant_accessible(tenant_id));

-- jobs: scope by customer_id or reseller_id
alter table if exists jobs enable row level security;
drop policy if exists jobs_no_anon_access on jobs;
create policy jobs_no_anon_access on jobs for all to anon using (false) with check (false);
drop policy if exists jobs_tenant_isolation on jobs;
create policy jobs_tenant_isolation on jobs for all to authenticated
  using (
    is_tenant_accessible(customer_id)
    or is_tenant_accessible(reseller_id)
    or (customer_id is null and reseller_id is null)
  );
