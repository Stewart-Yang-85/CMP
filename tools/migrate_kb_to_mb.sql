-- ============================================================
-- Migration: KB → MB 单位统一
-- 将 price plan 相关流量字段从 KB 改为 MB
-- 注意：Supabase SQL Editor 自动包装事务，无需手动 BEGIN/COMMIT
-- ============================================================

-- ============================================================
-- 1. price_plan_versions 表：列重命名 + 数值转换
-- ============================================================

-- 1a. 重命名列
ALTER TABLE price_plan_versions RENAME COLUMN quota_kb TO quota_mb;
ALTER TABLE price_plan_versions RENAME COLUMN per_sim_quota_kb TO per_sim_quota_mb;
ALTER TABLE price_plan_versions RENAME COLUMN total_quota_kb TO total_quota_mb;
ALTER TABLE price_plan_versions RENAME COLUMN overage_rate_per_kb TO overage_rate_per_mb;

-- 1b. 转换已有数据（配额类：KB÷1024=MB；费率类：×1024 从 per-KB 变 per-MB）
UPDATE price_plan_versions SET
  quota_mb          = CASE WHEN quota_mb IS NOT NULL          THEN CEIL(quota_mb::numeric / 1024)         END,
  per_sim_quota_mb  = CASE WHEN per_sim_quota_mb IS NOT NULL  THEN CEIL(per_sim_quota_mb::numeric / 1024) END,
  total_quota_mb    = CASE WHEN total_quota_mb IS NOT NULL    THEN CEIL(total_quota_mb::numeric / 1024)   END,
  overage_rate_per_mb = CASE WHEN overage_rate_per_mb IS NOT NULL THEN overage_rate_per_mb * 1024          END
WHERE quota_mb IS NOT NULL
   OR per_sim_quota_mb IS NOT NULL
   OR total_quota_mb IS NOT NULL
   OR overage_rate_per_mb IS NOT NULL;

-- 1c. tiers JSONB 键重命名 + 数值转换
--     fromKb → fromMb (÷1024), toKb → toMb (÷1024), ratePerKb → ratePerMb (×1024)
UPDATE price_plan_versions
SET tiers = (
  SELECT jsonb_agg(
    (elem - 'fromKb' - 'toKb' - 'ratePerKb') ||
    jsonb_build_object(
      'fromMb', CEIL((elem->>'fromKb')::numeric / 1024),
      'toMb',   CASE
                  WHEN elem->>'toKb' IS NULL THEN NULL
                  ELSE CEIL((elem->>'toKb')::numeric / 1024)
                END,
      'ratePerMb', (elem->>'ratePerKb')::numeric * 1024
    )
  )
  FROM jsonb_array_elements(tiers) AS elem
)
WHERE tiers IS NOT NULL AND jsonb_array_length(tiers) > 0;

-- 1d. payg_rates JSONB 键重命名 + 数值转换
--     ratePerKb → ratePerMb (×1024)
UPDATE price_plan_versions
SET payg_rates = (
  SELECT jsonb_agg(
    (elem - 'ratePerKb') || jsonb_build_object(
      'ratePerMb', (elem->>'ratePerKb')::numeric * 1024
    )
  )
  FROM jsonb_array_elements(payg_rates) AS elem
)
WHERE payg_rates IS NOT NULL AND jsonb_array_length(payg_rates) > 0;

-- ============================================================
-- 2. rating_results 表：列重命名 + 数值转换
--    需先删除依赖视图，改完后重建
-- ============================================================

-- 2a. 删除依赖视图和函数（顺序：先删外层再删内层）
DROP VIEW IF EXISTS v_golden_bill_summary CASCADE;
DROP VIEW IF EXISTS v_rating_results_golden CASCADE;

-- 2b. 重命名列（charged_kb → charged_mb 改为 numeric 支持小数 MB）
ALTER TABLE rating_results RENAME COLUMN charged_kb TO charged_mb_old;
ALTER TABLE rating_results ADD COLUMN charged_mb numeric(18, 6);
UPDATE rating_results SET charged_mb = charged_mb_old::numeric / 1024.0 WHERE charged_mb_old IS NOT NULL;
ALTER TABLE rating_results DROP COLUMN charged_mb_old;

ALTER TABLE rating_results RENAME COLUMN rate_per_kb TO rate_per_mb;

-- 2c. 转换费率数据
UPDATE rating_results SET
  rate_per_mb = rate_per_mb * 1024
WHERE rate_per_mb IS NOT NULL;

-- 2d. 重建视图（字段名更新为 MB）
CREATE OR REPLACE VIEW v_rating_results_golden AS
SELECT
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
FROM rating_results
WHERE calculation_id LIKE 'golden_case_%';

CREATE OR REPLACE VIEW v_golden_bill_summary AS
SELECT
  'golden'::text AS bill_key,
  min(created_at) AS first_created_at,
  max(created_at) AS last_created_at,
  count(*)::bigint AS line_count,
  sum(amount)::numeric(12, 2) AS total_amount,
  min(currency)::text AS currency
FROM v_rating_results_golden;

-- ============================================================
-- 3. package_versions.commercial_terms JSONB 中的 testQuotaKb
-- ============================================================

UPDATE package_versions
SET commercial_terms = (
  (commercial_terms - 'testQuotaKb') ||
  jsonb_build_object('testQuotaMb', CEIL((commercial_terms->>'testQuotaKb')::numeric / 1024))
)
WHERE commercial_terms IS NOT NULL
  AND commercial_terms ? 'testQuotaKb';

-- ============================================================
-- 4. 验证
-- ============================================================

DO $$
DECLARE
  v_kb_cols int;
BEGIN
  SELECT count(*) INTO v_kb_cols
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND column_name LIKE '%_kb';

  IF v_kb_cols > 0 THEN
    RAISE NOTICE 'WARNING: % columns still contain _kb suffix (usage/tracking fields expected)', v_kb_cols;
  END IF;

  RAISE NOTICE 'Migration KB→MB completed. Price plan columns renamed and values converted.';
END $$;

-- 迁移完成
