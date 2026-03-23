-- V009_deprecate_legacy_carriers.sql
-- Purpose: Remove legacy carrier catalog (carriers / supplier_carriers / public_infos link columns).
-- Business operator model: business_operators(operator_id) + operators(supplier_id, business_operator_id).
--
-- Run AFTER: 20260311100001_core_schema, 20260311100004_sim_connectivity (recommended full chain).
--
-- Pre-checks (optional, run in SQL Editor before this file):
--   select count(*) from operators where carrier_id is not null and business_operator_id is null;
--   select count(*) from sims where operator_id is null and carrier_id is not null;
--
-- Rollback: restore from backup; forward-only migration.

-- ============================================================
-- 1) Backfill operators.business_operator_id from catalog (MCC/MNC)
--    (skip if operators.carrier_id already dropped — e.g. partial re-run)
-- ============================================================

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'operators' and column_name = 'carrier_id'
  ) and to_regclass('public.public_infos') is not null then
    update operators o
    set business_operator_id = (
      select bo.operator_id
      from public_infos pi
      join business_operators bo on bo.mcc = pi.mcc and bo.mnc = pi.mnc
      where pi.public_info_id = o.carrier_id
      order by bo.operator_id
      limit 1
    )
    where o.business_operator_id is null
      and o.carrier_id is not null;
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'operators' and column_name = 'carrier_id'
  ) and exists (
    select 1
    from pg_class cl
    join pg_namespace ns on ns.oid = cl.relnamespace
    where ns.nspname = 'public'
      and cl.relname = 'carriers'
      and cl.relkind = 'r'
  ) then
    update operators o
    set business_operator_id = (
      select bo.operator_id
      from carriers c
      join business_operators bo on bo.mcc = c.mcc and bo.mnc = c.mnc
      where c.carrier_id = o.carrier_id
      order by bo.operator_id
      limit 1
    )
    where o.business_operator_id is null
      and o.carrier_id is not null;
  end if;
end $$;

-- ============================================================
-- 2) Backfill sims.operator_id / package_versions.operator_id
--    (only when BOTH sims/package_versions AND operators still have carrier_id)
-- ============================================================

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sims' and column_name = 'carrier_id'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'operators' and column_name = 'carrier_id'
  ) then
    update sims s
    set operator_id = x.operator_id
    from (
      select distinct on (s2.sim_id) s2.sim_id, o.operator_id
      from sims s2
      inner join operators o
        on o.supplier_id = s2.supplier_id
        and o.carrier_id is not distinct from s2.carrier_id
      where s2.operator_id is null
        and s2.carrier_id is not null
      order by s2.sim_id, o.operator_id
    ) x
    where s.sim_id = x.sim_id;
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'package_versions' and column_name = 'carrier_id'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'operators' and column_name = 'carrier_id'
  ) then
    update package_versions pv
    set operator_id = x.operator_id
    from (
      select distinct on (pv2.package_version_id) pv2.package_version_id, o.operator_id
      from package_versions pv2
      inner join operators o
        on o.supplier_id = pv2.supplier_id
        and o.carrier_id is not distinct from pv2.carrier_id
      where pv2.operator_id is null
        and pv2.carrier_id is not null
      order by pv2.package_version_id, o.operator_id
    ) x
    where pv.package_version_id = x.package_version_id;
  end if;
end $$;

-- ============================================================
-- 3) Drop legacy FK columns (carrier_id) on operator-facing tables
-- ============================================================

alter table if exists operators drop column if exists carrier_id;

alter table if exists sims drop column if exists carrier_id;

alter table if exists package_versions drop column if exists carrier_id;

alter table if exists apn_profiles drop column if exists carrier_id;

alter table if exists roaming_profiles drop column if exists carrier_id;

-- ============================================================
-- 4) Drop legacy junction + compatibility view + catalog table
-- ============================================================

drop table if exists supplier_carriers;

drop view if exists carriers cascade;

drop table if exists public_infos cascade;

-- If core_schema-only DB: carriers may still be a physical table (not renamed to public_infos)
drop table if exists carriers cascade;

-- ============================================================
-- Post-checks (optional):
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='sims' and column_name='carrier_id';
--   -- expect 0 rows
--   select to_regclass('public.supplier_carriers'), to_regclass('public.carriers');
--   -- expect NULL
-- ============================================================
