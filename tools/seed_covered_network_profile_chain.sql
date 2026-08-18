-- Phase 30 T227: CoveredNetworkProfile 样例 + 两条 FIXED_BUNDLE 资费共用同一 covered_network_profile_id
--
-- 前置：已执行 `covered_network_profiles` / `covered_network_profile_entries` / `price_plans.covered_network_profile_id` 迁移。
-- 企业：优先 `tenants.code = 'ENT_SUB_TEST'`（与 seed_subscriptions.sql 一致），否则任取一条 ENTERPRISE。
-- 用法：Supabase SQL Editor 执行；可重复执行（按固定 name 查重后插入）。

DO $$
DECLARE
  v_enterprise_id uuid;
  v_supplier_id uuid;
  v_operator_id uuid;
  v_covered_id uuid;
  v_exists int;
BEGIN
  SELECT tenant_id INTO v_enterprise_id
  FROM tenants
  WHERE code = 'ENT_SUB_TEST' AND tenant_type = 'ENTERPRISE'
  LIMIT 1;

  IF v_enterprise_id IS NULL THEN
    SELECT tenant_id INTO v_enterprise_id
    FROM tenants
    WHERE tenant_type = 'ENTERPRISE'
    LIMIT 1;
  END IF;

  IF v_enterprise_id IS NULL THEN
    RAISE EXCEPTION 'T227 seed: no ENTERPRISE tenant. Run seed_subscriptions.sql or create a tenant first.';
  END IF;

  SELECT supplier_id INTO v_supplier_id FROM suppliers LIMIT 1;
  SELECT operator_id INTO v_operator_id FROM operators WHERE supplier_id = v_supplier_id LIMIT 1;

  IF v_supplier_id IS NULL OR v_operator_id IS NULL THEN
    RAISE EXCEPTION 'T227 seed: need at least one supplier and one operator for that supplier.';
  END IF;

  SELECT covered_network_profile_id INTO v_covered_id
  FROM covered_network_profiles
  WHERE name = 'T227 Seed Shared Covered'
  LIMIT 1;

  IF v_covered_id IS NULL THEN
    INSERT INTO covered_network_profiles (
      name,
      reseller_id,
      supplier_id,
      operator_id,
      status,
      published_at,
      effective_from
    ) VALUES (
      'T227 Seed Shared Covered',
      NULL,
      v_supplier_id,
      v_operator_id,
      'PUBLISHED',
      current_timestamp,
      current_timestamp
    )
    RETURNING covered_network_profile_id INTO v_covered_id;

    INSERT INTO covered_network_profile_entries (covered_network_profile_id, mcc, mnc)
    VALUES
      (v_covered_id, '234', '15'),
      (v_covered_id, '460', '01');
  END IF;

  SELECT COUNT(*) INTO v_exists FROM price_plans
  WHERE enterprise_id = v_enterprise_id AND name = 'T227 Shared Covered Plan A';

  IF v_exists = 0 THEN
    INSERT INTO price_plans (
      enterprise_id,
      name,
      type,
      service_type,
      currency,
      billing_cycle_type,
      first_cycle_proration,
      version,
      status,
      effective_from,
      monthly_fee,
      deactivated_monthly_fee,
      total_quota_mb,
      overage_rate_per_mb,
      payg_rates,
      is_current,
      covered_network_profile_id
    ) VALUES (
      v_enterprise_id,
      'T227 Shared Covered Plan A',
      'FIXED_BUNDLE',
      'DATA',
      'USD',
      'CALENDAR_MONTH',
      'NONE',
      1,
      'DRAFT',
      NULL,
      10.00,
      1.00,
      500,
      0.01024,
      '{"zones":[]}'::jsonb,
      true,
      v_covered_id
    );
  END IF;

  SELECT COUNT(*) INTO v_exists FROM price_plans
  WHERE enterprise_id = v_enterprise_id AND name = 'T227 Shared Covered Plan B';

  IF v_exists = 0 THEN
    INSERT INTO price_plans (
      enterprise_id,
      name,
      type,
      service_type,
      currency,
      billing_cycle_type,
      first_cycle_proration,
      version,
      status,
      effective_from,
      monthly_fee,
      deactivated_monthly_fee,
      total_quota_mb,
      overage_rate_per_mb,
      payg_rates,
      is_current,
      covered_network_profile_id
    ) VALUES (
      v_enterprise_id,
      'T227 Shared Covered Plan B',
      'FIXED_BUNDLE',
      'DATA',
      'USD',
      'CALENDAR_MONTH',
      'NONE',
      1,
      'DRAFT',
      NULL,
      12.00,
      1.00,
      1024,
      0.02048,
      '{"zones":[]}'::jsonb,
      true,
      v_covered_id
    );
  END IF;

  RAISE NOTICE 'T227 seed: enterprise_id = %', v_enterprise_id;
  RAISE NOTICE 'T227 seed: covered_network_profile_id = % (shared by Plan A + Plan B)', v_covered_id;
END $$;
