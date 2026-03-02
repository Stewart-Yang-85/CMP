# API Service (Local)

本项目包含一个最小的 Node HTTP 服务，用于把 Supabase（视图/RPC）包装成与 `iot-cmp-api.yaml` 更接近的 REST 路径（当前实现 Bills）。

## 配置

复制 `.env.example` 为 `.env`（已在 `.gitignore` 忽略），并填写：

- `SUPABASE_URL`：形如 `https://pbxlnkbmzpqtacaxuqnk.supabase.co`
- `SUPABASE_ANON_KEY`：Supabase 项目的 anon key（JWT，`eyJ...`）
- `SUPABASE_SERVICE_ROLE_KEY`：可选；用于写操作（mark-paid/adjust）。不应出现在前端。
- `SUPABASE_TIMEOUT_MS`：Supabase REST 请求超时（毫秒）
- `SUPABASE_RETRY_MAX`：失败重试次数（包含 429/5xx 与网络错误）
- `SUPABASE_RETRY_BACKOFF_MS`：重试之间的等待（毫秒）
- `SUPABASE_CB_FAILURE_THRESHOLD`：熔断失败阈值（连续失败次数）
- `SUPABASE_CB_COOLDOWN_MS`：熔断冷却时间（毫秒；期间直接拒绝请求）
- `PORT`：可选，默认 `3000`

鉴权（可选，推荐开启）：

- `AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET`：`/v1/auth/token` 的 client credentials
- `AUTH_TOKEN_SECRET`：用于签发/校验 JWT（HS256）。设置后会强制校验 `Authorization: Bearer <token>`
- `AUTH_TOKEN_TTL_SECONDS`：token 过期时间（秒，默认 3600，范围 60~86400）
- `AUTH_ENTERPRISE_ID`：可选；如果使用环境变量模式签发 token，可把 enterpriseId 写入 JWT（用于租户隔离）
- `AUTH_USE_DB_CLIENTS=1`：可选；启用数据库中的下游 client（见 `api_clients` 表与 `npm.cmd run create-client`）
- `API_KEY`：可选；如果设置了，会校验 `X-API-Key` 是否匹配
- `ADMIN_API_KEY`：可选；如果设置，用于管理端接口（`/v1/admin/...`）的 `X-API-Key`

CORS（可选；用于浏览器侧直接调用 API）：

- `CORS_ALLOW_ORIGINS`：逗号分隔的 Origin 白名单，例如 `https://portal.example.com,http://localhost:5173`；支持 `*`
- `CORS_ALLOW_HEADERS`：可选；覆盖默认允许的请求头列表

限流（可选）：

- `RATE_LIMIT_TOKEN_WINDOW_MS` / `RATE_LIMIT_TOKEN_MAX`：对 `/v1/auth/token` 与 `/auth/token` 的窗口与最大次数（按 `clientId` 或 IP 计数）
- `RATE_LIMIT_ADMIN_WINDOW_MS` / `RATE_LIMIT_ADMIN_MAX`：对管理端路径 `/v1/admin/*` 与 `/admin/*` 的窗口与最大次数（按 `X-API-Key` 计数）
- `RATE_LIMIT_GLOBAL_WINDOW_MS` / `RATE_LIMIT_GLOBAL_MAX`：对受保护资源（`/v1/bills|sims|jobs` 及无前缀同名路径）的窗口与最大次数（按 `clientId` 或 IP 计数；为 0/空则不启用）
- `RATE_LIMIT_WRITE_WINDOW_MS` / `RATE_LIMIT_WRITE_MAX`：对写操作路径 `POST /v1/bills/{billId}:mark-paid|adjust`（及无前缀同名路径）的窗口与最大次数（按 `clientId` 或 IP 计数；为 0/空则不启用）

响应头：

- 命中/通过请求均返回：`X-RateLimit-Limit`、`X-RateLimit-Remaining`、`X-RateLimit-Reset`（Epoch 秒）
- 超限返回：HTTP 429 与 `Retry-After`（秒）

## 启动

Windows PowerShell 环境下建议使用 `npm.cmd`：

```powershell
npm.cmd install
npm.cmd start
```

启动后：`http://localhost:3000/health`

## 自动烟测

确保 `.env` 已配置好 `SUPABASE_URL` / `SUPABASE_ANON_KEY` 后执行：

```powershell
npm.cmd run smoke
```

## 端到端示例脚本与环境变量

- 脚本：
  - `node tools/e2e_demo.js`：认证→查询SIM→审计CSV→事件CSV→触发任务→任务CSV→Webhook
  - `node tools/e2e_demo_wx.js`：WX 供应商 webhook（SIM上线/流量告警/产品订单）
- 所需环境变量（按需设置，未设置的步骤会跳过）：
  - `AUTH_CLIENT_ID`、`AUTH_CLIENT_SECRET`：令牌交换
  - `ADMIN_API_KEY`：管理端接口与导出（审计/事件/任务）
  - `SUPABASE_SERVICE_ROLE_KEY`：触发管理端任务（评估测试到期、WX每日用量同步）
  - `CMP_WEBHOOK_KEY`、`SMOKE_SIM_ICCID`：CMP webhook（SIM状态变更）
  - `WXZHONGGENG_WEBHOOK_KEY`、`SMOKE_SIM_ICCID`：WX webhook（供应商通知）
  
- 最小变量集合（按脚本/功能拆分）：
  - 仅运行 `e2e_demo.js` 的认证/查询/审计CSV/事件CSV：`AUTH_CLIENT_ID`、`AUTH_CLIENT_SECRET`、`ADMIN_API_KEY`
  - 在上面基础上触发管理端任务：额外需要 `SUPABASE_SERVICE_ROLE_KEY`
  - 在上面基础上调用 CMP Webhook：额外需要 `CMP_WEBHOOK_KEY`、`SMOKE_SIM_ICCID`
  - 仅运行 `e2e_demo_wx.js`（WX 供应商 webhook 三类）：`WXZHONGGENG_WEBHOOK_KEY`、`SMOKE_SIM_ICCID`

## 指标暴露

- `GET /metrics`：暴露关键指标（文本），包含请求总数、错误数、429 次数、鉴权失败数与 P50/P95/P99 延迟（毫秒）。

## 创建下游 Client（数据库模式）

前提：已配置 `SUPABASE_SERVICE_ROLE_KEY`，并设置 `AUTH_TOKEN_SECRET` + `AUTH_USE_DB_CLIENTS=1`。

```powershell
npm.cmd run create-client -- --clientId demo-client --enterpriseId <tenant_uuid>
```

## 管理下游 Client（轮换/停用）

前提：设置 `ADMIN_API_KEY`。

- `GET /v1/admin/api-clients?enterpriseId=<tenant_uuid>&status=ACTIVE&page=1&limit=50`
- `POST /v1/admin/api-clients/{clientId}:rotate`（返回新的 `clientSecret`，只会在该响应中出现一次）
- `POST /v1/admin/api-clients/{clientId}:deactivate`

如果同时配置了 `SUPABASE_SERVICE_ROLE_KEY`，烟测会额外验证写接口：

- `POST /v1/bills/{billId}:mark-paid`
- `POST /v1/bills/{billId}:adjust`

## 已实现接口（/v1）

- `GET /v1/bills?period=2026-02&status=PUBLISHED&page=1&limit=20`
- `GET /v1/bills/{billId}`
- `GET /v1/bills/{billId}/files`
- `GET /v1/bills/{billId}/files/csv`
- `POST /v1/bills/{billId}:mark-paid`
- `POST /v1/bills/{billId}:adjust`
- `GET /v1/openapi.yaml`
- `GET /v1/docs`
- `POST /v1/auth/token`

同时提供不带前缀的鉴权路径：`POST /auth/token`（与 OpenAPI 对齐）。

同时提供不带前缀的路径：`/bills`、`/bills/{billId}` 等。

鉴权：除 `/health` 与 `/v1/auth/token` 外，需提供 `Authorization: Bearer <token>` 或 `X-API-Key: <key>`（当前仅做“存在性校验”，不校验值）。

## 快速验证（连 Supabase）

1) 先跑 Supabase 烟测（读）：

```powershell
$env:SUPABASE_URL = "https://pbxlnkbmzpqtacaxuqnk.supabase.co"
$env:SUPABASE_ANON_KEY = "<你的 anon key>"
powershell -NoProfile -ExecutionPolicy Bypass -File tools\\supabase_smoke_test.ps1
```

2) 再启动服务并请求 Bills：

```powershell
npm.cmd start
```

```powershell
Invoke-RestMethod "http://localhost:3000/v1/bills?period=2026-02" -Headers @{ Authorization = "Bearer demo" } | ConvertTo-Json -Depth 5
```

## 订阅与 commercial_terms 规范

- 字段位置：`package_versions.commercial_terms`（JSON）。用于控制测试期与订阅承诺期。
- 键名规范（统一使用 camelCase）：
  - `testPeriodDays`：测试期天数
  - `testQuotaKb`：测试期配额（KB）
  - `testExpiryCondition`：测试到期判定方式，取值 `PERIOD_ONLY` / `QUOTA_ONLY` / `PERIOD_OR_QUOTA`
  - `commitmentPeriodMonths`：订阅承诺期（月）
  - `commitmentPeriodDays`：订阅承诺期（天）
- 示例：

```json
{
  "commercial_terms": {
    "testPeriodDays": 14,
    "testQuotaKb": 102400,
    "testExpiryCondition": "PERIOD_OR_QUOTA",
    "commitmentPeriodMonths": 12
  }
}
```

- 生效逻辑（摘要）：
  - 订阅创建：`POST /v1/subscriptions`，请求体包含 `iccid`、`packageVersionId`、可选 `kind`（默认 `MAIN`）、`effectiveAt`（不传则次月 1 日 00:00:00Z）。服务读取目标套餐版本的 `commercial_terms`，计算并返回 `commitmentEndAt`。
  - 套餐切换：`POST /v1/subscriptions:switch`，原 `MAIN` 订阅标记为下月到期，新订阅在下月 1 日 00:00:00Z 生效，并依据新套餐版本的 `commercial_terms` 计算 `commitmentEndAt`。
  - 取消订阅：`POST /v1/subscriptions/{subscriptionId}:cancel`，`immediate=true` 立即取消并设置 `expiresAt=now`；否则设置为当月末（UTC）到期。
  - `commitmentEndAt` 计算规则：优先使用 `commitmentPeriodMonths`，按 UTC 自 `effectiveAt` 起加整月；若未设置月则使用 `commitmentPeriodDays` 按天数计算；均未设置则返回 `null`。

### 订阅创建示例（PowerShell）

```powershell
$body = @{
  iccid = "<SIM_ICCID>"
  packageVersionId = "<PACKAGE_VERSION_UUID>"
  kind = "MAIN"
  effectiveAt = "2026-02-01T00:00:00Z"
} | ConvertTo-Json

Invoke-RestMethod "http://localhost:3000/v1/subscriptions" -Method Post -Body $body -ContentType "application/json" -Headers @{ Authorization = "Bearer demo" } | ConvertTo-Json -Depth 5
```
