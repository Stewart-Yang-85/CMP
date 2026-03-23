-- V008_tenant_model_unification.sql
-- Fixes the "split-brain" between tenants table (Layer 1) and resellers/customers (Layer 2)
--
-- Problems solved:
--   1. customers.status (ACTIVE/OVERDUE/TERMINATED) vs tenants.enterprise_status (ACTIVE/SUSPENDED/INACTIVE) mismatch
--   2. No transactional guarantee when creating reseller/customer + tenants record via REST
--   3. auto_suspend_enabled not synced between layers
--
-- Approach (方案 B - 务实):
--   - Keep tenants as unified ID layer for FK references (sims, bills, subscriptions etc.)
--   - Add triggers to sync customers.status → tenants.enterprise_status
--   - Add transactional functions for atomic reseller/customer creation
--   - Add convenience views for unified queries
--
-- Rollback:
--   DROP FUNCTION IF EXISTS create_reseller, create_customer, sync_customer_status_to_tenant CASCADE;
--   DROP TRIGGER IF EXISTS trg_sync_customer_status ON customers;
--   DROP VIEW IF EXISTS customer_view, reseller_view CASCADE;

-- ============================================================
-- 0. Ensure tenant_id columns exist (may be missing from legacy 0035 schema)
-- ============================================================

alter table if exists resellers
  add column if not exists tenant_id uuid references tenants(tenant_id) unique;

alter table if exists customers
  add column if not exists tenant_id uuid references tenants(tenant_id) unique;

-- ============================================================
-- 1. Status sync trigger: customers → tenants
-- ============================================================
-- Mapping: ACTIVE→ACTIVE, OVERDUE→SUSPENDED, TERMINATED→INACTIVE

create or replace function sync_customer_status_to_tenant()
returns trigger as $$
declare
  mapped_status enterprise_status;
begin
  -- Map customer_status → enterprise_status
  case NEW.status::text
    when 'ACTIVE' then mapped_status := 'ACTIVE';
    when 'OVERDUE' then mapped_status := 'SUSPENDED';
    when 'TERMINATED' then mapped_status := 'INACTIVE';
    else mapped_status := 'ACTIVE';
  end case;

  update tenants
  set enterprise_status = mapped_status,
      auto_suspend_enabled = NEW.auto_suspend_enabled,
      updated_at = current_timestamp
  where tenant_id = NEW.tenant_id;

  return NEW;
end;
$$ language plpgsql;

drop trigger if exists trg_sync_customer_status on customers;
create trigger trg_sync_customer_status
  after insert or update of status, auto_suspend_enabled
  on customers
  for each row
  execute function sync_customer_status_to_tenant();

-- ============================================================
-- 2. Transactional function: create_reseller
-- ============================================================
-- Atomically creates tenants record + resellers record in one call
-- Callable via Supabase RPC: supabase.rpc('create_reseller', { ... })

create or replace function create_reseller(
  p_name text,
  p_contact_email text default null,
  p_contact_phone text default null,
  p_created_by uuid default null,
  p_currency text default 'CNY'
)
returns jsonb as $$
declare
  v_tenant_id uuid;
  v_reseller_id uuid;
begin
  -- Validate
  if p_name is null or trim(p_name) = '' then
    raise exception 'reseller name is required' using errcode = 'P0001';
  end if;

  -- Check uniqueness
  if exists (select 1 from resellers where name = trim(p_name)) then
    raise exception 'reseller name already exists: %', p_name using errcode = '23505';
  end if;

  -- Create tenants record
  insert into tenants (tenant_type, name, enterprise_status, code)
  values ('RESELLER', trim(p_name), 'ACTIVE', 'R-' || substr(gen_random_uuid()::text, 1, 8))
  returning tenant_id into v_tenant_id;

  -- Create resellers record
  insert into resellers (tenant_id, name, status, contact_email, contact_phone, created_by)
  values (v_tenant_id, trim(p_name), 'ACTIVE', p_contact_email, p_contact_phone, p_created_by)
  returning id into v_reseller_id;

  -- Create default branding
  insert into reseller_branding (reseller_id, brand_name, currency)
  values (v_tenant_id, trim(p_name), coalesce(p_currency, 'CNY'));

  return jsonb_build_object(
    'tenant_id', v_tenant_id,
    'reseller_id', v_reseller_id,
    'name', trim(p_name),
    'status', 'ACTIVE'
  );
end;
$$ language plpgsql security definer;

-- ============================================================
-- 3. Transactional function: create_customer
-- ============================================================
-- Atomically creates tenants record + customers record in one call

create or replace function create_customer(
  p_reseller_id uuid,
  p_name text,
  p_auto_suspend_enabled boolean default true,
  p_created_by uuid default null
)
returns jsonb as $$
declare
  v_tenant_id uuid;
  v_customer_id uuid;
  v_reseller_tenant_id uuid;
begin
  -- Validate
  if p_name is null or trim(p_name) = '' then
    raise exception 'customer name is required' using errcode = 'P0001';
  end if;

  -- Verify reseller exists
  select tenant_id into v_reseller_tenant_id
  from resellers where id = p_reseller_id and status != 'DEACTIVATED';
  if v_reseller_tenant_id is null then
    raise exception 'reseller not found or deactivated: %', p_reseller_id using errcode = 'P0002';
  end if;

  -- Check uniqueness within reseller
  if exists (select 1 from customers where reseller_id = p_reseller_id and name = trim(p_name)) then
    raise exception 'customer name already exists under this reseller: %', p_name using errcode = '23505';
  end if;

  -- Create tenants record (parent_id = reseller's tenant_id)
  insert into tenants (parent_id, tenant_type, name, enterprise_status, auto_suspend_enabled)
  values (v_reseller_tenant_id, 'ENTERPRISE', trim(p_name), 'ACTIVE', p_auto_suspend_enabled)
  returning tenant_id into v_tenant_id;

  -- Create customers record
  insert into customers (tenant_id, reseller_id, name, status, auto_suspend_enabled, created_by)
  values (v_tenant_id, p_reseller_id, trim(p_name), 'ACTIVE', p_auto_suspend_enabled, p_created_by)
  returning id into v_customer_id;

  return jsonb_build_object(
    'tenant_id', v_tenant_id,
    'customer_id', v_customer_id,
    'reseller_id', p_reseller_id,
    'name', trim(p_name),
    'status', 'ACTIVE'
  );
end;
$$ language plpgsql security definer;

-- ============================================================
-- 4. Convenience views for unified queries
-- ============================================================

create or replace view customer_view as
select
  c.id as customer_id,
  c.tenant_id,
  c.reseller_id,
  c.name,
  c.status as customer_status,
  c.api_key,
  c.webhook_url,
  c.auto_suspend_enabled,
  c.created_by,
  c.created_at,
  c.updated_at,
  t.parent_id as reseller_tenant_id,
  t.enterprise_status as tenant_status,
  r.name as reseller_name
from customers c
join tenants t on c.tenant_id = t.tenant_id
join resellers r on c.reseller_id = r.id;

create or replace view reseller_view as
select
  r.id as reseller_id,
  r.tenant_id,
  r.name,
  r.status as reseller_status,
  r.contact_email,
  r.contact_phone,
  r.created_by,
  r.created_at,
  r.updated_at,
  rb.brand_name,
  rb.currency,
  rb.custom_domain,
  rb.logo_url
from resellers r
left join reseller_branding rb on rb.reseller_id = r.tenant_id;

-- ============================================================
-- 5. Backfill: sync existing customers to tenants
-- ============================================================
-- For any customers that already exist, ensure tenants row is in sync

do $$
declare
  rec record;
  mapped enterprise_status;
begin
  for rec in select c.tenant_id, c.status, c.auto_suspend_enabled from customers c loop
    case rec.status::text
      when 'ACTIVE' then mapped := 'ACTIVE';
      when 'OVERDUE' then mapped := 'SUSPENDED';
      when 'TERMINATED' then mapped := 'INACTIVE';
      else mapped := 'ACTIVE';
    end case;

    update tenants
    set enterprise_status = mapped,
        auto_suspend_enabled = rec.auto_suspend_enabled,
        updated_at = current_timestamp
    where tenant_id = rec.tenant_id
      and (enterprise_status is distinct from mapped
           or auto_suspend_enabled is distinct from rec.auto_suspend_enabled);
  end loop;
end $$;
