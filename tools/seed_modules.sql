-- ============================================================
-- Seed: Control Policy / Carrier Service / Commercial Terms 模块
-- 用于测试 Package 创建流程
-- Control Policy JSON：T205（cutoff / throttling），非旧 cutoffRules / throttlingRules
-- Phase 30 T227（CoveredNetworkProfile + 双 FIXED_BUNDLE 共用 covered）：见 tools/seed_covered_network_profile_chain.sql
-- ============================================================

DO $$
DECLARE
  v_cp_id_1   uuid;
  v_cp_id_2   uuid;
  v_cs_id_1   uuid;
  v_cs_id_2   uuid;
  v_ct_id_1   uuid;
  v_ct_id_2   uuid;
  v_supplier_id uuid;
  v_operator_id uuid;
BEGIN

  -- 查找已有的 supplier 和 operator
  SELECT supplier_id INTO v_supplier_id FROM suppliers LIMIT 1;
  SELECT operator_id INTO v_operator_id FROM operators LIMIT 1;

  IF v_supplier_id IS NULL THEN
    RAISE EXCEPTION 'No supplier found. Please seed suppliers first.';
  END IF;

  RAISE NOTICE 'supplier_id = %, operator_id = %', v_supplier_id, v_operator_id;

  -- ============================================================
  -- 1. Control Policy 模块
  -- ============================================================

  -- CP-1: 达量断网策略（月 2048MB 断网）— T205 形状：cutoff / throttling（非 cutoffRules / throttlingRules）
  INSERT INTO control_policy_modules (name, control_policy, status, published_at, effective_from)
  VALUES (
    'Seed CP monthly cutoff 2GB',
    '{
      "enabled": true,
      "cutoff": {
        "timeWindow": "MONTHLY",
        "thresholdMb": 2048,
        "action": "DEACTIVATED"
      }
    }'::jsonb,
    'PUBLISHED',
    current_timestamp,
    current_timestamp
  )
  RETURNING control_policy_id INTO v_cp_id_1;

  -- CP-2: 达量限速策略（日 500MB 起限速至 128kbps）
  INSERT INTO control_policy_modules (name, control_policy, status, published_at, effective_from)
  VALUES (
    'Seed CP daily throttle 500MB tier',
    '{
      "enabled": true,
      "throttling": {
        "timeWindow": "DAILY",
        "tiers": [
          { "thresholdMb": 500, "downlinkKbps": 128, "uplinkKbps": 64 }
        ]
      }
    }'::jsonb,
    'PUBLISHED',
    current_timestamp,
    current_timestamp
  )
  RETURNING control_policy_id INTO v_cp_id_2;

  RAISE NOTICE 'Control Policy 1 (cutoff 2GB/月): %', v_cp_id_1;
  RAISE NOTICE 'Control Policy 2 (throttle 500MB/日): %', v_cp_id_2;

  -- ============================================================
  -- 2. Carrier Service 模块
  -- ============================================================

  -- CS-1: 4G Data 服务
  INSERT INTO carrier_service_modules (
    name, supplier_id, operator_id, apn_profile_id, roaming_profile_id, rat, status, published_at, effective_from
  )
  VALUES (
    'Seed CS 4G Data',
    v_supplier_id,
    v_operator_id,
    NULL,
    NULL,
    '4G',
    'PUBLISHED',
    current_timestamp,
    current_timestamp
  )
  RETURNING carrier_service_id INTO v_cs_id_1;

  -- CS-2: NB-IoT Data 服务
  INSERT INTO carrier_service_modules (
    name, supplier_id, operator_id, apn_profile_id, roaming_profile_id, rat, status, published_at, effective_from
  )
  VALUES (
    'Seed CS NB-IoT Data',
    v_supplier_id,
    v_operator_id,
    NULL,
    NULL,
    'NB-IOT',
    'PUBLISHED',
    current_timestamp,
    current_timestamp
  )
  RETURNING carrier_service_id INTO v_cs_id_2;

  RAISE NOTICE 'Carrier Service 1 (4G Data): %', v_cs_id_1;
  RAISE NOTICE 'Carrier Service 2 (NB-IoT): %', v_cs_id_2;

  -- ============================================================
  -- 3. Commercial Terms 模块
  -- ============================================================

  -- CT-1: 7天测试期，100MB 测试配额
  INSERT INTO commercial_terms_modules (name, commercial_terms, status, published_at, effective_from)
  VALUES (
    'Seed CT 7d trial 100MB',
    '{
    "testPeriodDays": 7,
    "testQuotaMb": 100,
    "testExpiryCondition": "PERIOD_OR_QUOTA",
    "testExpiryAction": "ACTIVATED",
    "commitmentPeriodMonths": 12
  }'::jsonb,
    'PUBLISHED',
    current_timestamp,
    current_timestamp
  )
  RETURNING commercial_terms_id INTO v_ct_id_1;

  -- CT-2: 无测试期，24个月承诺期
  INSERT INTO commercial_terms_modules (name, commercial_terms, status, published_at, effective_from)
  VALUES (
    'Seed CT no trial 24mo',
    '{
    "testPeriodDays": 0,
    "testQuotaMb": 0,
    "testExpiryCondition": "PERIOD_ONLY",
    "testExpiryAction": "ACTIVATED",
    "commitmentPeriodMonths": 24
  }'::jsonb,
    'PUBLISHED',
    current_timestamp,
    current_timestamp
  )
  RETURNING commercial_terms_id INTO v_ct_id_2;

  RAISE NOTICE 'Commercial Terms 1 (7天测试+12月承诺): %', v_ct_id_1;
  RAISE NOTICE 'Commercial Terms 2 (无测试+24月承诺): %', v_ct_id_2;

  -- ============================================================
  -- 汇总
  -- ============================================================
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Seed 完成，可用于创建 Package 时引用：';
  RAISE NOTICE '  controlPolicyId:    % (cutoff) 或 % (throttle)', v_cp_id_1, v_cp_id_2;
  RAISE NOTICE '  carrierServiceId:   % (4G) 或 % (NB-IoT)', v_cs_id_1, v_cs_id_2;
  RAISE NOTICE '  commercialTermsId:  % (测试期) 或 % (无测试)', v_ct_id_1, v_ct_id_2;
  RAISE NOTICE '========================================';

END $$;
