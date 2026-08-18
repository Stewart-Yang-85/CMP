# 环境变量与 CI Smoke 测试

## Supabase 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `SUPABASE_URL` | ✅ | Supabase 项目 URL，如 `https://xxx.supabase.co` |
| `SUPABASE_ANON_KEY` | ✅ | anon key（JWT），用于只读/RLS 受限操作 |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅* | service role key，用于写操作（billing、mark-paid、adjust 等）；smoke 完整测试需要 |

*应用启动只需 URL + ANON_KEY；写操作与完整 smoke 需 SERVICE_ROLE_KEY。

## 鉴权相关

| 变量 | 必填 | 说明 |
|------|------|------|
| `AUTH_TOKEN_SECRET` | ✅ | JWT 签发/校验密钥（HS256），至少 32 字符 |
| `AUTH_CLIENT_ID` | 可选 | 本地 M2M，用于 `POST /v1/auth/token` 与 `POST /v1/auth/login`（clientId/clientSecret） |
| `AUTH_CLIENT_SECRET` | 可选 | 与 `AUTH_CLIENT_ID` 配对 |
| `AUTH_ENTERPRISE_ID` | 可选 | 设置后 env M2M JWT 为 **customer_m2m**；测 **platform_admin**（如 upstream-integrations）时不要设置 |
| `ADMIN_API_KEY` | 可选 | 管理端 `X-API-Key`，smoke 中 admin 测试需要 |

## .env 检查结果

当前 `.env` 中已正确配置：

- ✅ `SUPABASE_URL`
- ✅ `SUPABASE_ANON_KEY`
- ✅ `SUPABASE_SERVICE_ROLE_KEY`
- ✅ `AUTH_TOKEN_SECRET`
- ✅ `AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET`
- ✅ `ADMIN_API_KEY`

**未使用（可忽略）**：

- `SUPABASE_PROJECT_URL` — 与 `SUPABASE_URL` 重复
- `SUPABASE_PUBLISHABLE_KEY` — 本服务使用 `SUPABASE_ANON_KEY`
- `DIRECT_CONNECTION_STRING` — 本服务使用 REST API，非直连

## CI Smoke 测试

已新增 `.github/workflows/smoke.yml`，在 push/PR 到 main/master 时执行 `npm run smoke`。

**需在 GitHub Repo → Settings → Secrets and variables → Actions 中配置：**

| Secret | 必填 | 说明 |
|--------|------|------|
| `SUPABASE_URL` | ✅ | 同 .env |
| `SUPABASE_ANON_KEY` | ✅ | 同 .env |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | 同 .env |
| `AUTH_TOKEN_SECRET` | ✅ | 同 .env |
| `AUTH_CLIENT_ID` | 可选 | 不设则 smoke 用默认值 |
| `AUTH_CLIENT_SECRET` | 可选 | 不设则 smoke 用默认值 |
| `ADMIN_API_KEY` | 可选 | 用于 admin 接口测试 |

配置完成后，每次 push 或 PR 将自动运行 smoke 测试。

## Worker / Scheduler 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `USAGE_RATING_ROLLUP_CRON` | 可选 | 周期性 Rating / Usage Rollup 排队计划，默认 `*/30 * * * *`。任务创建 `USAGE_RATING_ROLLUP` Job，刷新当前账期 `rating_results`、`usage_daily_summary` classified MB 与 `usage_package_daily_summary`，不生成账单。 |
| `ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_PERCENT` | 可选 | `OUT_OF_PROFILE_SURGE` 百分比阈值，默认 `20`，表示当前账期产品包 out-of-profile 用量达到适用配额的 20% 时触发。旧 `ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_KB` 仅在数值不超过 100 时作为兼容 fallback。 |
| `ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_PERCENT_BY_RESELLER` | 可选 | JSON map，按 reseller 覆盖 `OUT_OF_PROFILE_SURGE` 百分比阈值。 |
| `ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_PERCENT_BY_ENTERPRISE` | 可选 | JSON map，按 enterprise 覆盖 `OUT_OF_PROFILE_SURGE` 百分比阈值。 |
