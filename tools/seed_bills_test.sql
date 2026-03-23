-- 测试用 bills 数据插入脚本
-- 用于测试 GET /bills 接口（admin / customer / reseller 三种角色）
--
-- 使用前请确认：
-- 1. enterprise_id 在 tenants 表中存在且 tenant_type = 'ENTERPRISE'
-- 2. reseller_id（如有）在 tenants 表中存在且 tenant_type = 'RESELLER'
-- 3. 若 enterprise 属于某 reseller，tenants 中该 enterprise 的 parent_id 应等于 reseller_id
--
-- 步骤 1：查询现有 tenant（在 Supabase SQL Editor 中执行）
-- SELECT tenant_id, tenant_type, parent_id, name FROM tenants WHERE tenant_type IN ('ENTERPRISE','RESELLER') ORDER BY tenant_type, name LIMIT 30;
--
-- 步骤 2：将下方 enterprise_id / reseller_id 替换为你的实际值后执行 INSERT

-- 示例：插入 2026-03 账期账单（请将 enterprise_id / reseller_id 替换为你的实际值）
INSERT INTO bills (
  enterprise_id,
  period_start,
  period_end,
  status,
  currency,
  total_amount,
  due_date,
  reseller_id,
  generated_at
) VALUES
  -- 企业 a2367c54（假设属于 reseller 803f6988）
  (
    'a2367c54-fd82-4e07-a013-3d4c345ca7eb',
    '2026-03-01',
    '2026-03-31',
    'GENERATED',
    'USD',
    150.00,
    '2026-04-10',
    '803f6988-9a1b-48b8-adb6-a8e063dd418a',
    now()
  ),
  -- 企业 57b91fb1
  (
    '57b91fb1-3841-495a-8dcb-97ae7e323ca7',
    '2026-03-01',
    '2026-03-31',
    'PUBLISHED',
    'USD',
    88.50,
    '2026-04-10',
    NULL,
    now()
  ),
  -- 企业 e35a8598
  (
    'e35a8598-6a47-4f68-9fe2-5ebc10d492ae',
    '2026-03-01',
    '2026-03-31',
    'GENERATED',
    'USD',
    200.00,
    NULL,
    NULL,
    now()
  )
ON CONFLICT (enterprise_id, period_start, period_end) DO NOTHING;

-- 若需插入属于同一 reseller 的多个企业账单（用于测试 reseller 列表）：
-- 先确认 tenants 中 parent_id = '803f6988-9a1b-48b8-adb6-a8e063dd418a' 的 enterprise_id
-- 例如：
/*
INSERT INTO bills (enterprise_id, period_start, period_end, status, currency, total_amount, due_date, reseller_id, generated_at)
SELECT
  t.tenant_id,
  '2026-04-01',
  '2026-04-30',
  'GENERATED',
  'USD',
  100.00,
  '2026-05-10',
  '803f6988-9a1b-48b8-adb6-a8e063dd418a',
  now()
FROM tenants t
WHERE t.parent_id = '803f6988-9a1b-48b8-adb6-a8e063dd418a'
  AND t.tenant_type = 'ENTERPRISE'
ON CONFLICT (enterprise_id, period_start, period_end) DO NOTHING;
*/
