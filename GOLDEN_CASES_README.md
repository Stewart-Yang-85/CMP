# Golden Cases

本目录文件用于把 `CMP_Requirements_Workshop.md` 的第 10 章“计费黄金用例集”固化为机器可读的回归测试输入/期望输出。

- 用例文件：`golden_cases.json`
- 用途：规则实现前/实现中/回归时，确保“用量匹配、PAYG、月租高水位、迟到话单调账”等口径不漂移。

## 结构概览

- `meta`
  - `currency`：默认币种（示例用 USD）
  - `unit`：数据单位约定（1MB=1024KB，按 CEIL 向上取整）
- `catalog.packages`
  - 用例所需的主套餐/叠加包（覆盖范围、配额、PAYG、套外单价等）
- `cases[]`
  - 每个用例包含：`context`（输入）与 `expect`（期望输出）

## 用例类型

- `usage_match`
  - 验证：waterfall（叠加包优先、范围最小优先、主套餐兜底）
- `payg_out_of_profile`
  - 验证：Out-of-Profile 不扣减套餐；命中 PAYG 计费或触发“PAYG 规则缺失”
- `overage_when_exhausted`
  - 验证：套餐配额耗尽后的套外计费（overageRatePerKb）
- `inactive_usage`
  - 验证：停机状态（DEACTIVATED）仍产生用量时，按 Out-of-Profile + 告警处理
- `monthly_fee_high_water`
  - 验证：月租高水位（账期内出现过 ACTIVATED 即收全额；否则按停机保号费/不收费）
- `late_cdr_adjustment`
  - 验证：已发布账期的迟到话单进入调账草稿

## 运行校验

执行：`tools/validate_golden_cases.ps1`。

## 导出 SQL（rating_results）

将离线计费器输出转换为可导入数据库的 SQL：

- 生成脚本：`tools/export_rating_results_sql.ps1`
- 输出文件：`fixtures/rating_results_golden.sql`

## Supabase 烟测

前提：通过 Supabase 项目面板拿到项目 URL 与 anon key（不要把 service role key 放到前端）。

`tools/supabase_smoke_test.ps1` 会自动尝试从项目根目录的 `.env` 读取 `SUPABASE_URL`/`SUPABASE_ANON_KEY`（如果环境变量未设置）。

执行：

```powershell
$env:SUPABASE_URL = "https://<project-ref>.supabase.co"
$env:SUPABASE_ANON_KEY = "<anon-key>"
powershell -NoProfile -ExecutionPolicy Bypass -File tools\supabase_smoke_test.ps1
```

烟测会做两类验证：
- `v_rating_results_golden` 行数与 `sum(amount)` 是否符合预期
- RPC `get_golden_bill_summary()` 是否返回 `total_amount=512.0` 且 `line_count>=8`

## Bills API（Supabase RPC 形态）

已在数据库侧提供与 `iot-cmp-api.yaml` 的 `/bills` 语义对应的 RPC：

- `list_bills(p_period, p_status, p_limit, p_offset) -> { items, total }`
- `get_bill(p_bill_id) -> Bill`
- `get_bill_files(p_bill_id) -> { pdfUrl, csvUrl }`

并通过数据库断言迁移校验：`0011_assert_bills_api.sql`。

注意：`SUPABASE_URL` 必须是纯 URL 字符串（不要加反引号/不要有空格/不要带 `<` `>`）。

如果出现 URI 解析错误，通常是 `SUPABASE_URL` 还没替换（或包含空格/换行）。可先执行 dry-run 检查 URL：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\\supabase_smoke_test.ps1 -DryRun
```
