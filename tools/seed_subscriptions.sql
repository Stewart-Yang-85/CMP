-- seed_subscriptions.sql
-- 为 subscriptions 模块测试生成完整的前置数据和订阅记录
-- 在 Supabase SQL Editor 中执行
-- 幂等：可重复执行，ON CONFLICT DO NOTHING

-- Fix legacy tables that may be missing columns
alter table if exists package_versions
  add column if not exists price_plan_version_id uuid references price_plan_versions(price_plan_version_id),
  add column if not exists carrier_id uuid,
  add column if not exists service_type service_type not null default 'DATA',
  add column if not exists apn text,
  add column if not exists roaming_profile jsonb,
  add column if not exists throttling_policy jsonb,
  add column if not exists control_policy jsonb,
  add column if not exists commercial_terms jsonb;

do $$
declare
  v_enterprise_id uuid;
  v_supplier_id uuid;
  v_sim1_id uuid;
  v_sim2_id uuid;
  v_sim3_id uuid;
  v_sim4_id uuid;
  v_price_plan_id uuid;
  v_ppv_id uuid;
  v_price_plan2_id uuid;
  v_ppv2_id uuid;
  v_package_id uuid;
  v_pkgv_id uuid;
  v_package2_id uuid;
  v_pkgv2_id uuid;
begin
  -- ============================================================
  -- 1. Enterprise (tenant)
  -- ============================================================
  select tenant_id into v_enterprise_id
  from tenants where code = 'ENT_SUB_TEST' limit 1;

  if v_enterprise_id is null then
    insert into tenants (tenant_type, code, name, enterprise_status, auto_suspend_enabled)
    values ('ENTERPRISE', 'ENT_SUB_TEST', 'Subscription Test Enterprise', 'ACTIVE', true)
    returning tenant_id into v_enterprise_id;
  end if;

  raise notice 'enterprise_id = %', v_enterprise_id;

  -- ============================================================
  -- 2. Supplier
  -- ============================================================
  select supplier_id into v_supplier_id
  from suppliers where name = 'Sub Test Supplier' limit 1;

  if v_supplier_id is null then
    insert into suppliers (name, status)
    values ('Sub Test Supplier', 'ACTIVE')
    returning supplier_id into v_supplier_id;
  end if;

  raise notice 'supplier_id = %', v_supplier_id;

  -- ============================================================
  -- 3. SIM cards (4 cards, different statuses)
  -- ============================================================
  select sim_id into v_sim1_id from sims where iccid = '89860099000000100001' limit 1;
  if v_sim1_id is null then
    insert into sims (iccid, primary_imsi, msisdn, supplier_id, enterprise_id, status, apn)
    values ('89860099000000100001', '460001000000001', '8613900000001', v_supplier_id, v_enterprise_id, 'ACTIVATED', 'iot.test')
    returning sim_id into v_sim1_id;
  end if;

  select sim_id into v_sim2_id from sims where iccid = '89860099000000100002' limit 1;
  if v_sim2_id is null then
    insert into sims (iccid, primary_imsi, msisdn, supplier_id, enterprise_id, status, apn)
    values ('89860099000000100002', '460001000000002', '8613900000002', v_supplier_id, v_enterprise_id, 'ACTIVATED', 'iot.test')
    returning sim_id into v_sim2_id;
  end if;

  select sim_id into v_sim3_id from sims where iccid = '89860099000000100003' limit 1;
  if v_sim3_id is null then
    insert into sims (iccid, primary_imsi, msisdn, supplier_id, enterprise_id, status, apn)
    values ('89860099000000100003', '460001000000003', '8613900000003', v_supplier_id, v_enterprise_id, 'ACTIVATED', 'iot.test')
    returning sim_id into v_sim3_id;
  end if;

  select sim_id into v_sim4_id from sims where iccid = '89860099000000100004' limit 1;
  if v_sim4_id is null then
    insert into sims (iccid, primary_imsi, msisdn, supplier_id, enterprise_id, status, apn)
    values ('89860099000000100004', '460001000000004', '8613900000004', v_supplier_id, v_enterprise_id, 'DEACTIVATED', 'iot.test')
    returning sim_id into v_sim4_id;
  end if;

  raise notice 'sim_ids = %, %, %, %', v_sim1_id, v_sim2_id, v_sim3_id, v_sim4_id;

  -- ============================================================
  -- 4. Price Plans + Versions (FIXED_BUNDLE + ONE_TIME)
  -- ============================================================

  -- Plan A: Fixed Bundle 500MB/月, $10/月, 超量 $0.01/KB
  select price_plan_id into v_price_plan_id
  from price_plans where enterprise_id = v_enterprise_id and name = 'Fixed 500MB Monthly' limit 1;

  if v_price_plan_id is null then
    insert into price_plans (enterprise_id, name, type, service_type, currency, billing_cycle_type)
    values (v_enterprise_id, 'Fixed 500MB Monthly', 'FIXED_BUNDLE', 'DATA', 'USD', 'CALENDAR_MONTH')
    returning price_plan_id into v_price_plan_id;
  end if;

  select price_plan_version_id into v_ppv_id
  from price_plan_versions where price_plan_id = v_price_plan_id and version = 1 limit 1;

  if v_ppv_id is null then
    insert into price_plan_versions (
      price_plan_id, version, effective_from,
      monthly_fee, quota_kb, overage_rate_per_kb,
      payg_rates
    ) values (
      v_price_plan_id, 1, '2026-01-01T00:00:00Z',
      10.00, 512000, 0.00001,
      '[{"mcc":"460","mnc":"*","ratePerKb":0.00002}]'::jsonb
    )
    returning price_plan_version_id into v_ppv_id;
  end if;

  -- Plan B: One-time 100MB, $5, 有效期 30 天
  select price_plan_id into v_price_plan2_id
  from price_plans where enterprise_id = v_enterprise_id and name = 'One-Time 100MB' limit 1;

  if v_price_plan2_id is null then
    insert into price_plans (enterprise_id, name, type, service_type, currency, billing_cycle_type)
    values (v_enterprise_id, 'One-Time 100MB', 'ONE_TIME', 'DATA', 'USD', 'CALENDAR_MONTH')
    returning price_plan_id into v_price_plan2_id;
  end if;

  select price_plan_version_id into v_ppv2_id
  from price_plan_versions where price_plan_id = v_price_plan2_id and version = 1 limit 1;

  if v_ppv2_id is null then
    insert into price_plan_versions (
      price_plan_id, version, effective_from,
      one_time_fee, quota_kb, validity_days
    ) values (
      v_price_plan2_id, 1, '2026-01-01T00:00:00Z',
      5.00, 102400, 30
    )
    returning price_plan_version_id into v_ppv2_id;
  end if;

  raise notice 'price_plan_version_ids = %, %', v_ppv_id, v_ppv2_id;

  -- ============================================================
  -- 5. Packages + Package Versions (PUBLISHED)
  -- ============================================================

  -- Package A: 月租套餐
  select package_id into v_package_id
  from packages where enterprise_id = v_enterprise_id and name = 'IoT Monthly Bundle A' limit 1;

  if v_package_id is null then
    insert into packages (enterprise_id, name)
    values (v_enterprise_id, 'IoT Monthly Bundle A')
    returning package_id into v_package_id;
  end if;

  select package_version_id into v_pkgv_id
  from package_versions where package_id = v_package_id and version = 1 limit 1;

  if v_pkgv_id is null then
    insert into package_versions (
      package_id, version, status, effective_from,
      supplier_id, service_type, price_plan_version_id
    ) values (
      v_package_id, 1, 'PUBLISHED', '2026-01-01T00:00:00Z',
      v_supplier_id, 'DATA', v_ppv_id
    )
    returning package_version_id into v_pkgv_id;
  end if;

  -- Package B: 一次性流量包
  select package_id into v_package2_id
  from packages where enterprise_id = v_enterprise_id and name = 'IoT One-Time 100MB' limit 1;

  if v_package2_id is null then
    insert into packages (enterprise_id, name)
    values (v_enterprise_id, 'IoT One-Time 100MB')
    returning package_id into v_package2_id;
  end if;

  select package_version_id into v_pkgv2_id
  from package_versions where package_id = v_package2_id and version = 1 limit 1;

  if v_pkgv2_id is null then
    insert into package_versions (
      package_id, version, status, effective_from,
      supplier_id, service_type, price_plan_version_id
    ) values (
      v_package2_id, 1, 'PUBLISHED', '2026-01-01T00:00:00Z',
      v_supplier_id, 'DATA', v_ppv2_id
    )
    returning package_version_id into v_pkgv2_id;
  end if;

  raise notice 'package_version_ids = %, %', v_pkgv_id, v_pkgv2_id;

  -- ============================================================
  -- 6. Subscriptions (6 records, covering all states and kinds)
  -- ============================================================

  -- Sub 1: SIM1 + PackageA (MAIN, ACTIVE) — 正常活跃月租订阅
  insert into subscriptions (
    enterprise_id, sim_id, subscription_kind, package_version_id,
    state, effective_at, expires_at, first_subscribed_at
  )
  select v_enterprise_id, v_sim1_id, 'MAIN', v_pkgv_id,
         'ACTIVE', '2026-01-15T00:00:00Z', null, '2026-01-15T00:00:00Z'
  where not exists (
    select 1 from subscriptions
    where sim_id = v_sim1_id and package_version_id = v_pkgv_id and state = 'ACTIVE'
  );

  -- Sub 2: SIM1 + PackageB (ADD_ON, ACTIVE) — 叠加包，30天后过期
  insert into subscriptions (
    enterprise_id, sim_id, subscription_kind, package_version_id,
    state, effective_at, expires_at, first_subscribed_at
  )
  select v_enterprise_id, v_sim1_id, 'ADD_ON', v_pkgv2_id,
         'ACTIVE', '2026-02-01T00:00:00Z', '2026-03-03T00:00:00Z', '2026-02-01T00:00:00Z'
  where not exists (
    select 1 from subscriptions
    where sim_id = v_sim1_id and package_version_id = v_pkgv2_id and state = 'ACTIVE'
  );

  -- Sub 3: SIM2 + PackageA (MAIN, ACTIVE) — 另一张卡的活跃订阅
  insert into subscriptions (
    enterprise_id, sim_id, subscription_kind, package_version_id,
    state, effective_at, expires_at, first_subscribed_at
  )
  select v_enterprise_id, v_sim2_id, 'MAIN', v_pkgv_id,
         'ACTIVE', '2026-02-01T00:00:00Z', null, '2026-02-01T00:00:00Z'
  where not exists (
    select 1 from subscriptions
    where sim_id = v_sim2_id and package_version_id = v_pkgv_id and state = 'ACTIVE'
  );

  -- Sub 4: SIM3 + PackageA (MAIN, CANCELLED) — 已退订
  insert into subscriptions (
    enterprise_id, sim_id, subscription_kind, package_version_id,
    state, effective_at, cancelled_at, first_subscribed_at
  )
  select v_enterprise_id, v_sim3_id, 'MAIN', v_pkgv_id,
         'CANCELLED', '2026-01-10T00:00:00Z', '2026-02-15T00:00:00Z', '2026-01-10T00:00:00Z'
  where not exists (
    select 1 from subscriptions
    where sim_id = v_sim3_id and package_version_id = v_pkgv_id and state = 'CANCELLED'
  );

  -- Sub 5: SIM3 + PackageB (ADD_ON, EXPIRED) — 已过期的一次性包
  insert into subscriptions (
    enterprise_id, sim_id, subscription_kind, package_version_id,
    state, effective_at, expires_at, first_subscribed_at
  )
  select v_enterprise_id, v_sim3_id, 'ADD_ON', v_pkgv2_id,
         'EXPIRED', '2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z', '2026-01-01T00:00:00Z'
  where not exists (
    select 1 from subscriptions
    where sim_id = v_sim3_id and package_version_id = v_pkgv2_id and state = 'EXPIRED'
  );

  -- Sub 6: SIM4 + PackageA (MAIN, PENDING) — 待生效（下个周期生效）
  insert into subscriptions (
    enterprise_id, sim_id, subscription_kind, package_version_id,
    state, effective_at, first_subscribed_at, commitment_end_at
  )
  select v_enterprise_id, v_sim4_id, 'MAIN', v_pkgv_id,
         'PENDING', '2026-04-01T00:00:00Z', null, '2026-09-30T00:00:00Z'
  where not exists (
    select 1 from subscriptions
    where sim_id = v_sim4_id and package_version_id = v_pkgv_id and state = 'PENDING'
  );

  raise notice '=== Subscription seed complete ===';
  raise notice 'Enterprise: ENT_SUB_TEST (%)  ', v_enterprise_id;
  raise notice 'SIM ICCIDs: 89860099000000100001 ~ 100004';
  raise notice 'Package A (Monthly Bundle): %', v_pkgv_id;
  raise notice 'Package B (One-Time):       %', v_pkgv2_id;
end $$;

-- ============================================================
-- 验证查询：确认数据已正确插入
-- ============================================================
select
  s.subscription_id,
  s.state,
  s.subscription_kind as kind,
  sim.iccid,
  pkg.name as package_name,
  s.effective_at,
  s.expires_at,
  s.cancelled_at,
  s.commitment_end_at
from subscriptions s
join sims sim on sim.sim_id = s.sim_id
join package_versions pv on pv.package_version_id = s.package_version_id
join packages pkg on pkg.package_id = pv.package_id
where s.enterprise_id = (select tenant_id from tenants where code = 'ENT_SUB_TEST')
order by sim.iccid, s.effective_at;
