-- ============================================================
-- Seed: Control Policy / Carrier Service / Commercial Terms 模块
-- 用于测试 Package 创建流程
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

  -- CP-1: 达量断网策略（月 2048MB 断网）
  INSERT INTO control_policy_modules (control_policy)
  VALUES ('{
    "enabled": true,
    "cutoffRules": [
      {
        "timeWindow": "MONTHLY",
        "thresholdMb": 2048,
        "action": "DEACTIVATED"
      }
    ],
    "throttlingRules": []
  }'::jsonb)
  RETURNING control_policy_id INTO v_cp_id_1;

  -- CP-2: 达量限速策略（日 500MB 限速至 128kbps）
  INSERT INTO control_policy_modules (control_policy)
  VALUES ('{
    "enabled": true,
    "cutoffRules": [],
    "throttlingRules": [
      {
        "timeWindow": "DAILY",
        "tiers": [
          { "thresholdMb": 500, "downlinkKbps": 128, "uplinkKbps": 64 }
        ]
      }
    ]
  }'::jsonb)
  RETURNING control_policy_id INTO v_cp_id_2;

  RAISE NOTICE 'Control Policy 1 (cutoff 2GB/月): %', v_cp_id_1;
  RAISE NOTICE 'Control Policy 2 (throttle 500MB/日): %', v_cp_id_2;

  -- ============================================================
  -- 2. Carrier Service 模块
  -- ============================================================

  -- CS-1: 4G Data 服务
  INSERT INTO carrier_service_modules (supplier_id, operator_id, carrier_service_config)
  VALUES (
    v_supplier_id,
    v_operator_id,
    jsonb_build_object(
      'supplierId', v_supplier_id,
      'operatorId', v_operator_id,
      'rat', '4G',
      'serviceType', 'DATA',
      'apn', 'iot.test',
      'roamingProfile', jsonb_build_object(
        'entries', jsonb_build_array(
          jsonb_build_object('mcc', '460', 'mnc', '*', 'ratePerMb', 0.05),
          jsonb_build_object('mcc', '234', 'mnc', '*', 'ratePerMb', 0.20),
          jsonb_build_object('mcc', '208', 'mnc', '01', 'ratePerMb', 0.15)
        )
      )
    )
  )
  RETURNING carrier_service_id INTO v_cs_id_1;

  -- CS-2: NB-IoT Data 服务
  INSERT INTO carrier_service_modules (supplier_id, operator_id, carrier_service_config)
  VALUES (
    v_supplier_id,
    v_operator_id,
    jsonb_build_object(
      'supplierId', v_supplier_id,
      'operatorId', v_operator_id,
      'rat', 'NB-IoT',
      'serviceType', 'DATA',
      'apn', 'nbiot.test',
      'roamingProfile', jsonb_build_object(
        'entries', jsonb_build_array(
          jsonb_build_object('mcc', '460', 'mnc', '*', 'ratePerMb', 0.02)
        )
      )
    )
  )
  RETURNING carrier_service_id INTO v_cs_id_2;

  RAISE NOTICE 'Carrier Service 1 (4G Data): %', v_cs_id_1;
  RAISE NOTICE 'Carrier Service 2 (NB-IoT): %', v_cs_id_2;

  -- ============================================================
  -- 3. Commercial Terms 模块
  -- ============================================================

  -- CT-1: 7天测试期，100MB 测试配额
  INSERT INTO commercial_terms_modules (commercial_terms)
  VALUES ('{
    "testPeriodDays": 7,
    "testQuotaMb": 100,
    "testExpiryCondition": "PERIOD_OR_QUOTA",
    "testExpiryAction": "ACTIVATED",
    "commitmentPeriodMonths": 12
  }'::jsonb)
  RETURNING commercial_terms_id INTO v_ct_id_1;

  -- CT-2: 无测试期，24个月承诺期
  INSERT INTO commercial_terms_modules (commercial_terms)
  VALUES ('{
    "testPeriodDays": 0,
    "testQuotaMb": 0,
    "testExpiryCondition": "PERIOD_ONLY",
    "testExpiryAction": "ACTIVATED",
    "commitmentPeriodMonths": 24
  }'::jsonb)
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
