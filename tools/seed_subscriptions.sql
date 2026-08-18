-- seed_subscriptions.sql
-- 为 subscriptions 模块测试生成完整的前置数据和订阅记录
-- 适用：已执行 Phase 19（price_plans 单表快照）+ Phase 28（packages 单实体，`subscriptions.package_id`）
-- 在 Supabase SQL Editor 中执行；幂等：可重复执行（ON CONFLICT / WHERE NOT EXISTS）

do $$
declare
  v_enterprise_id uuid;
  v_supplier_id uuid;
  v_sim1_id uuid;
  v_sim2_id uuid;
  v_sim3_id uuid;
  v_sim4_id uuid;
  v_price_plan_id uuid;
  v_price_plan2_id uuid;
  v_pkg_monthly_id uuid;
  v_pkg_onetime_id uuid;
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
  -- 4. Price Plans（单表快照，无 price_plan_versions）
  -- ============================================================
  select price_plan_id into v_price_plan_id
  from price_plans where enterprise_id = v_enterprise_id and name = 'Fixed 500MB Monthly' limit 1;

  if v_price_plan_id is null then
    insert into price_plans (
      enterprise_id, name, type, service_type, currency, billing_cycle_type, first_cycle_proration,
      version, effective_from, monthly_fee, quota_mb, overage_rate_per_mb, payg_rates, is_current
    ) values (
      v_enterprise_id, 'Fixed 500MB Monthly', 'FIXED_BUNDLE', 'DATA', 'USD', 'CALENDAR_MONTH', 'NONE',
      1, '2026-01-01T00:00:00Z', 10.00, 500, 0.01024,
      '[{"mcc":"460","mnc":"*","ratePerMb":0.02048}]'::jsonb,
      true
    ) returning price_plan_id into v_price_plan_id;
  end if;

  select price_plan_id into v_price_plan2_id
  from price_plans where enterprise_id = v_enterprise_id and name = 'One-Time 100MB' limit 1;

  if v_price_plan2_id is null then
    insert into price_plans (
      enterprise_id, name, type, service_type, currency, billing_cycle_type, first_cycle_proration,
      version, effective_from, one_time_fee, quota_mb, validity_days, is_current
    ) values (
      v_enterprise_id, 'One-Time 100MB', 'ONE_TIME', 'DATA', 'USD', 'CALENDAR_MONTH', 'NONE',
      1, '2026-01-01T00:00:00Z', 5.00, 100, 30, true
    ) returning price_plan_id into v_price_plan2_id;
  end if;

  raise notice 'price_plan_ids = %, %', v_price_plan_id, v_price_plan2_id;

  -- ============================================================
  -- 5. Packages（可售行 = public.packages）
  -- ============================================================
  select package_id into v_pkg_monthly_id
  from packages where enterprise_id = v_enterprise_id and name = 'IoT Monthly Bundle A' limit 1;

  if v_pkg_monthly_id is null then
    insert into packages (
      enterprise_id, name, status, effective_from, published_at,
      price_plan_id
    ) values (
      v_enterprise_id, 'IoT Monthly Bundle A', 'PUBLISHED', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
      v_price_plan_id
    ) returning package_id into v_pkg_monthly_id;
  end if;

  select package_id into v_pkg_onetime_id
  from packages where enterprise_id = v_enterprise_id and name = 'IoT One-Time 100MB' limit 1;

  if v_pkg_onetime_id is null then
    insert into packages (
      enterprise_id, name, status, effective_from, published_at,
      price_plan_id
    ) values (
      v_enterprise_id, 'IoT One-Time 100MB', 'PUBLISHED', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
      v_price_plan2_id
    ) returning package_id into v_pkg_onetime_id;
  end if;

  raise notice 'package_ids (sellable) = %, %', v_pkg_monthly_id, v_pkg_onetime_id;

  -- ============================================================
  -- 6. Subscriptions
  -- ============================================================
  insert into subscriptions (
    enterprise_id, sim_id, subscription_kind, package_id,
    state, effective_at, expires_at, first_subscribed_at
  )
  select v_enterprise_id, v_sim1_id, 'MAIN', v_pkg_monthly_id,
         'ACTIVE', '2026-01-15T00:00:00Z', null, '2026-01-15T00:00:00Z'
  where not exists (
    select 1 from subscriptions
    where sim_id = v_sim1_id and package_id = v_pkg_monthly_id and state = 'ACTIVE'
  );

  insert into subscriptions (
    enterprise_id, sim_id, subscription_kind, package_id,
    state, effective_at, expires_at, first_subscribed_at
  )
  select v_enterprise_id, v_sim1_id, 'ADD_ON', v_pkg_onetime_id,
         'ACTIVE', '2026-02-01T00:00:00Z', '2026-03-03T00:00:00Z', '2026-02-01T00:00:00Z'
  where not exists (
    select 1 from subscriptions
    where sim_id = v_sim1_id and package_id = v_pkg_onetime_id and state = 'ACTIVE'
  );

  insert into subscriptions (
    enterprise_id, sim_id, subscription_kind, package_id,
    state, effective_at, expires_at, first_subscribed_at
  )
  select v_enterprise_id, v_sim2_id, 'MAIN', v_pkg_monthly_id,
         'ACTIVE', '2026-02-01T00:00:00Z', null, '2026-02-01T00:00:00Z'
  where not exists (
    select 1 from subscriptions
    where sim_id = v_sim2_id and package_id = v_pkg_monthly_id and state = 'ACTIVE'
  );

  insert into subscriptions (
    enterprise_id, sim_id, subscription_kind, package_id,
    state, effective_at, cancelled_at, first_subscribed_at
  )
  select v_enterprise_id, v_sim3_id, 'MAIN', v_pkg_monthly_id,
         'CANCELLED', '2026-01-10T00:00:00Z', '2026-02-15T00:00:00Z', '2026-01-10T00:00:00Z'
  where not exists (
    select 1 from subscriptions
    where sim_id = v_sim3_id and package_id = v_pkg_monthly_id and state = 'CANCELLED'
  );

  insert into subscriptions (
    enterprise_id, sim_id, subscription_kind, package_id,
    state, effective_at, expires_at, first_subscribed_at
  )
  select v_enterprise_id, v_sim3_id, 'ADD_ON', v_pkg_onetime_id,
         'EXPIRED', '2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z', '2026-01-01T00:00:00Z'
  where not exists (
    select 1 from subscriptions
    where sim_id = v_sim3_id and package_id = v_pkg_onetime_id and state = 'EXPIRED'
  );

  insert into subscriptions (
    enterprise_id, sim_id, subscription_kind, package_id,
    state, effective_at, first_subscribed_at, commitment_end_at
  )
  select v_enterprise_id, v_sim4_id, 'MAIN', v_pkg_monthly_id,
         'PENDING', '2026-04-01T00:00:00Z', null, '2026-09-30T00:00:00Z'
  where not exists (
    select 1 from subscriptions
    where sim_id = v_sim4_id and package_id = v_pkg_monthly_id and state = 'PENDING'
  );

  raise notice '=== Subscription seed complete ===';
  raise notice 'Enterprise: ENT_SUB_TEST (%)  ', v_enterprise_id;
  raise notice 'SIM ICCIDs: 89860099000000100001 ~ 100004';
  raise notice 'Package A (Monthly Bundle): %', v_pkg_monthly_id;
  raise notice 'Package B (One-Time):       %', v_pkg_onetime_id;
end $$;

-- 验证查询
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
join packages pkg on pkg.package_id = s.package_id
where s.enterprise_id = (select tenant_id from tenants where code = 'ENT_SUB_TEST')
order by sim.iccid, s.effective_at;
