-- V1.1 Phase 19: Price Plan Snapshot Model + KB→MB Unit Standardization
-- Tasks: T087 (merge price_plan_versions into price_plans),
--        T088 (update package_versions FK),
--        T089 (drop price_plan_versions table)
--
-- Changes:
--   1. Merge price_plan_versions data into price_plans as a single-table snapshot model.
--      Each version becomes an independent snapshot row, tracked by source_price_plan_id (self FK).
--   2. Rename all KB-related columns to MB across the database.
--
-- Rollback:
--   This migration is NOT trivially reversible due to data merges and column renames.
--   A dedicated down migration would be required.

begin;

-- ============================================================
-- 1. Add version/pricing columns to price_plans (from price_plan_versions)
-- ============================================================

alter table price_plans
  add column if not exists source_price_plan_id uuid references price_plans(price_plan_id),
  add column if not exists version int,
  add column if not exists effective_from timestamptz,
  add column if not exists monthly_fee numeric(12, 2) not null default 0,
  add column if not exists deactivated_monthly_fee numeric(12, 2) not null default 0,
  add column if not exists one_time_fee numeric(12, 2),
  add column if not exists quota_mb bigint,
  add column if not exists validity_days int,
  add column if not exists per_sim_quota_mb bigint,
  add column if not exists total_quota_mb bigint,
  add column if not exists overage_rate_per_mb numeric(18, 8),
  add column if not exists tiers jsonb,
  add column if not exists payg_rates jsonb,
  add column if not exists is_current boolean not null default true,
  add column if not exists updated_at timestamptz not null default current_timestamp;

comment on column price_plans.source_price_plan_id is
  'Self-FK: points to the original price plan this snapshot was derived from. NULL for originals.';
comment on column price_plans.is_current is
  'TRUE for the latest/active version, FALSE for superseded snapshots.';

-- Index for snapshot lineage queries
create index if not exists idx_price_plans_source on price_plans(source_price_plan_id);
-- Index for finding the current version of a plan
create index if not exists idx_price_plans_current on price_plans(enterprise_id, is_current) where is_current = true;

-- ============================================================
-- 2. Migrate data: insert each price_plan_version as a new price_plans snapshot row
-- ============================================================
-- Strategy:
--   For each price_plan_versions row, create a new price_plans row that carries:
--     - All parent columns (enterprise_id, name, type, etc.) from the original price_plan
--     - All version columns (version, monthly_fee, quota, tiers, etc.) from price_plan_versions
--     - source_price_plan_id pointing to the original price_plan
--     - is_current = false (will be updated for the latest version afterward)
--
-- We also maintain a mapping table to repoint FKs later.

-- Temporary mapping: old price_plan_version_id → new price_plan_id
create temporary table _ppv_migration_map (
  old_price_plan_version_id uuid not null,
  new_price_plan_id uuid not null
) on commit drop;

do $$
declare
  rec record;
  v_new_id uuid;
begin
  for rec in
    select
      ppv.price_plan_version_id,
      ppv.price_plan_id as parent_id,
      ppv.version,
      ppv.effective_from,
      ppv.monthly_fee,
      ppv.deactivated_monthly_fee,
      ppv.one_time_fee,
      ppv.quota_kb,
      ppv.validity_days,
      ppv.per_sim_quota_kb,
      ppv.total_quota_kb,
      ppv.overage_rate_per_kb,
      ppv.tiers,
      ppv.payg_rates,
      ppv.created_at as version_created_at,
      pp.enterprise_id,
      pp.name,
      pp.type,
      pp.service_type,
      pp.currency,
      pp.billing_cycle_type,
      pp.first_cycle_proration
    from price_plan_versions ppv
    join price_plans pp on ppv.price_plan_id = pp.price_plan_id
    order by ppv.price_plan_id, ppv.version
  loop
    v_new_id := gen_random_uuid();

    insert into price_plans (
      price_plan_id,
      enterprise_id,
      name,
      type,
      service_type,
      currency,
      billing_cycle_type,
      first_cycle_proration,
      source_price_plan_id,
      version,
      effective_from,
      monthly_fee,
      deactivated_monthly_fee,
      one_time_fee,
      quota_mb,
      validity_days,
      per_sim_quota_mb,
      total_quota_mb,
      overage_rate_per_mb,
      tiers,
      payg_rates,
      is_current,
      created_at,
      updated_at
    )
    values (
      v_new_id,
      rec.enterprise_id,
      rec.name,
      rec.type,
      rec.service_type,
      rec.currency,
      rec.billing_cycle_type,
      rec.first_cycle_proration,
      rec.parent_id,
      rec.version,
      rec.effective_from,
      rec.monthly_fee,
      rec.deactivated_monthly_fee,
      rec.one_time_fee,
      rec.quota_kb,        -- KB values stored as-is; column is now named _mb (unit relabeling)
      rec.validity_days,
      rec.per_sim_quota_kb,
      rec.total_quota_kb,
      rec.overage_rate_per_kb,
      rec.tiers,
      rec.payg_rates,
      false,                -- will mark latest as current below
      rec.version_created_at,
      rec.version_created_at
    );

    insert into _ppv_migration_map (old_price_plan_version_id, new_price_plan_id)
    values (rec.price_plan_version_id, v_new_id);
  end loop;
end $$;

-- Mark the highest-versioned snapshot per source as current
update price_plans pp
set is_current = true
where pp.source_price_plan_id is not null
  and pp.version = (
    select max(pp2.version)
    from price_plans pp2
    where pp2.source_price_plan_id = pp.source_price_plan_id
  );

-- Original price_plans rows that had NO versions stay is_current = true (default).
-- Original price_plans rows that DID have versions are now "parents" — mark them not current
-- so only the latest snapshot is active.
update price_plans pp
set is_current = false
where exists (
  select 1 from price_plans child
  where child.source_price_plan_id = pp.price_plan_id
)
and pp.source_price_plan_id is null;

-- ============================================================
-- 3. T088: Repoint package_versions FK from price_plan_version_id to price_plan_id
-- ============================================================

-- Add the new column
alter table package_versions
  add column if not exists price_plan_id uuid;

-- Populate from the migration map
update package_versions pv
set price_plan_id = m.new_price_plan_id
from _ppv_migration_map m
where pv.price_plan_version_id = m.old_price_plan_version_id;

-- For any package_versions rows not matched (shouldn't happen, but be safe),
-- leave price_plan_id NULL and log a warning via RAISE NOTICE
do $$
declare
  v_unmatched bigint;
begin
  select count(*) into v_unmatched
  from package_versions
  where price_plan_version_id is not null
    and price_plan_id is null;
  if v_unmatched > 0 then
    raise notice 'WARNING: % package_versions rows have price_plan_version_id but no matching migrated price_plan_id', v_unmatched;
  end if;
end $$;

-- Add FK constraint to new column
alter table package_versions
  add constraint fk_package_versions_price_plan
  foreign key (price_plan_id) references price_plans(price_plan_id);

create index if not exists idx_package_versions_price_plan_id
  on package_versions(price_plan_id);

-- Drop the old FK constraint and column
alter table package_versions
  drop constraint if exists package_versions_price_plan_version_id_fkey;

-- Also drop the redundant add-column FK if it exists (from the ALTER in core_schema)
do $$
declare
  v_constraint_name text;
begin
  select tc.constraint_name into v_constraint_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name
    and tc.table_schema = kcu.table_schema
  where tc.table_name = 'package_versions'
    and kcu.column_name = 'price_plan_version_id'
    and tc.constraint_type = 'FOREIGN KEY'
  limit 1;

  if v_constraint_name is not null then
    execute format('alter table package_versions drop constraint %I', v_constraint_name);
  end if;
end $$;

alter table package_versions
  drop column if exists price_plan_version_id;

-- ============================================================
-- 4. Repoint rating_results FK from matched_price_plan_version_id to matched_price_plan_id
-- ============================================================

-- Add the new column
alter table rating_results
  add column if not exists matched_price_plan_id uuid;

-- Populate from the migration map
update rating_results rr
set matched_price_plan_id = m.new_price_plan_id
from _ppv_migration_map m
where rr.matched_price_plan_version_id = m.old_price_plan_version_id;

-- Add FK constraint
alter table rating_results
  add constraint fk_rating_results_matched_price_plan
  foreign key (matched_price_plan_id) references price_plans(price_plan_id);

-- Drop the old FK constraint and column
do $$
declare
  v_constraint_name text;
begin
  select tc.constraint_name into v_constraint_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name
    and tc.table_schema = kcu.table_schema
  where tc.table_name = 'rating_results'
    and kcu.column_name = 'matched_price_plan_version_id'
    and tc.constraint_type = 'FOREIGN KEY'
  limit 1;

  if v_constraint_name is not null then
    execute format('alter table rating_results drop constraint %I', v_constraint_name);
  end if;
end $$;

alter table rating_results
  drop column if exists matched_price_plan_version_id;

-- ============================================================
-- 5. T089: Drop price_plan_versions table
-- ============================================================

drop table if exists price_plan_versions cascade;

-- ============================================================
-- 6. KB→MB column renames across all tables
-- ============================================================

-- 6a. usage_daily_summary: uplink_kb → uplink_mb, downlink_kb → downlink_mb, total_kb → total_mb
alter table usage_daily_summary
  rename column uplink_kb to uplink_mb;
alter table usage_daily_summary
  rename column downlink_kb to downlink_mb;
alter table usage_daily_summary
  rename column total_kb to total_mb;

-- 6b. rating_results: charged_kb → charged_mb, rate_per_kb → rate_per_mb
alter table rating_results
  rename column charged_kb to charged_mb;
alter table rating_results
  rename column rate_per_kb to rate_per_mb;

-- 6c. Recreate views that reference renamed columns

-- v_rating_results_golden (from V002); v_golden_bill_summary depends on it.
-- PG forbids CREATE OR REPLACE VIEW when output column names change (charged_kb → charged_mb).
drop view if exists v_golden_bill_summary cascade;
drop view if exists v_rating_results_golden cascade;

create view v_rating_results_golden as
select
  rating_result_id,
  calculation_id,
  iccid,
  visited_mccmnc,
  input_ref,
  classification,
  charged_mb,
  rate_per_mb,
  amount,
  currency,
  created_at
from rating_results
where calculation_id like 'golden_case_%';

create or replace view v_golden_bill_summary as
select
  'golden'::text as bill_key,
  min(created_at) as first_created_at,
  max(created_at) as last_created_at,
  count(*)::bigint as line_count,
  sum(amount)::numeric(12, 2) as total_amount,
  min(currency)::text as currency
from v_rating_results_golden;

create or replace function get_golden_bill_summary()
returns table (
  bill_key text,
  first_created_at timestamptz,
  last_created_at timestamptz,
  line_count bigint,
  total_amount numeric(12, 2),
  currency text
)
language sql
stable
as $$
  select
    bill_key,
    first_created_at,
    last_created_at,
    line_count,
    total_amount,
    currency
  from v_golden_bill_summary;
$$;

-- ============================================================
-- 7. Add unique constraint for snapshot versioning
-- ============================================================

-- Ensure (source_price_plan_id, version) is unique for snapshot lineage
-- Only applies to snapshot rows (source_price_plan_id IS NOT NULL)
create unique index if not exists idx_price_plans_source_version
  on price_plans(source_price_plan_id, version)
  where source_price_plan_id is not null;

commit;
