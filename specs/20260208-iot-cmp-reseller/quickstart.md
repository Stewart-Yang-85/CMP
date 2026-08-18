# Quickstart: IoT CMP Reseller System

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08

---

## 1. 环境准备

### 1.1 前置依赖

| 工具 | 版本 | 说明 |
|------|------|------|
| Node.js | 18+ LTS | 运行时 |
| npm | 9+ | 包管理 |
| Supabase CLI | latest | 本地数据库管理 |
| Vercel CLI | latest | 部署（可选） |

### 1.2 克隆与安装

```bash
git clone <repo-url>
cd 04_Project_CMP1
npm install
```

### 1.3 环境变量

创建 `.env` 文件：

```env
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# JWT
JWT_SECRET=your-jwt-secret-at-least-32-chars

# Server
PORT=3000
NODE_ENV=development

# Vendor (wxzhonggeng) — legacy; prefer DB upstream_integrations (Phase 37)
# WX_API_BASE=https://api.wxzhonggeng.com
# WX_API_KEY=your-vendor-api-key

# Phase 37: encrypt upstream_integrations.api_secret / webhook_key at rest
INTEGRATION_SECRET_KEY=your-integration-master-key-at-least-32-chars
```

### 1.4 启动数据库

```bash
# 本地 Supabase（Docker 方式）
npx supabase start

# 或使用远程 Supabase 实例
# 确保 SUPABASE_URL 和 KEY 已配置
```

### 1.5 运行迁移

```bash
# 迁移文件位于 supabase/migrations/
# 按顺序执行 0001 ~ 0018（已有）+ 0019 ~ 0035（新增）
npx supabase db push
```

---

## 2. 项目结构

```
src/
├── app.ts               # Fastify 主应用（64 个端点）
├── server.ts            # HTTP 入口
├── queues/
│   └── handlers.ts      # 异步任务处理器
├── cron/                # Vercel Cron 触发入口
├── billing.ts           # 计费引擎
├── supabaseRest.ts      # Supabase REST 客户端（重试 + 熔断器）
├── jwt.ts               # JWT 签发与验证
├── password.ts          # 密码哈希（scrypt）
└── vendors/
    ├── wxzhonggeng.ts   # 微众耕 供应商适配器
    ├── wxzhonggeng_config.json
    └── wxzhonggeng_schema.json

supabase/migrations/     # PostgreSQL 迁移文件（18 个已有 + 17 个新增）
tools/                   # 测试与工具脚本（23 个）
gen/ts-fetch/            # 生成的 TypeScript Fetch 客户端
fixtures/                # 测试数据
specs/                   # 设计文档
```

---

## 3. 启动开发

### 3.1 启动 API 服务

```bash
node src/server.ts
# 或
npm start

# 默认监听 http://localhost:3000
# Swagger UI: http://localhost:3000/api-docs
```

### 3.2 启动 Worker

```bash
node src/queues/handlers.ts
```

### 3.3 运行测试

```bash
# API 烟测（82KB 测试脚本）
node tools/api_smoke_test.js

# 计费 E2E 测试
node tools/test_billing_e2e.js

# 端到端演示
node tools/e2e_demo.js

# 微众耕 E2E 演示
node tools/e2e_demo_wx.js
```

### 3.4 curl 与代理商 ID（FR-058）

手工请求里路径/查询中的 `resellerId`、以及 `tools/gen_token.js --resellerId` 的参数，一律使用 **RESELLER 的 `tenants.tenant_id`**（`create_reseller` RPC 返回 JSON 的 `tenant_id`），**不要**使用 `resellers.id`（返回体中的 `reseller_id` 仅用于 DB RPC 如 `create_customer`）。

示例：

```bash
# 自前面 seed / create_reseller 得到 TENANT_ID 后：
node tools/gen_token.js --scope reseller --resellerId "$TENANT_ID"
curl -sS "http://localhost:3000/v1/resellers/$TENANT_ID/suppliers" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

### 3.5 Golden Test Cases

```bash
# 计费黄金用例验证
# 用例定义: golden_cases.json
# 验证逻辑: supabase/migrations/0006_assert_golden.sql
# 预期结果: supabase/migrations/0005_golden_summary.sql
```

---

## 4. 开发约定

### 4.1 代码风格

- **语言**: TypeScript (ES Module)
- **类型参考**: `gen/ts-fetch/types.d.ts`（113 KB）提供完整类型定义
- **模块**: ESM (`import/export`)，`package.json` 中 `"type": "module"`
- **命名**: camelCase（TS）/ snake_case（数据库）

### 4.2 数据库访问

```javascript
// 使用 Supabase REST 客户端
import { supabaseRest } from './supabaseRest.ts';

// 内置重试 + 熔断器
const { data, error } = await supabaseRest
  .from('sims')
  .select('*')
  .eq('iccid', iccid);
```

### 4.3 认证

```javascript
// JWT HS256 签发
import { signToken, verifyToken } from './jwt.ts';

const token = signToken({
  userId,
  resellerId,   // reseller 时：RESELLER tenants.tenant_id（FR-058）；非 resellers.id
  roleScope,    // 'platform' | 'reseller' | 'customer'
  role
});

// 中间件验证
app.addHook('onRequest', verifyToken);
```

### 4.4 供应商适配器

```javascript
// 现有适配器: src/vendors/wxzhonggeng.ts
// 调用示例:
import { WxZhonggeng } from './vendors/wxzhonggeng.ts';

const vendor = new WxZhonggeng(config);
await vendor.activateSim({ iccid, idempotencyKey });
await vendor.getDailyUsage({ iccid, date });
```

### 4.5 异步任务

```javascript
// 通过 jobs 表驱动
// queues/handlers.ts 处理队列任务
// Vercel Cron 触发队列入口
// 状态: QUEUED → RUNNING → SUCCEEDED/FAILED/CANCELLED
```

---

## 5. API 端点一览

### 5.1 已有端点（64 个，定义于 iot-cmp-api.yaml）

- **Authentication**: POST /v1/auth/login, /v1/auth/refresh
- **SIMs**: GET/POST /v1/sims, GET /v1/sims/{simId}, PATCH /v1/sims/{simId}
- **Subscriptions**: GET/POST /v1/subscriptions, GET /v1/sims/{simId}/subscriptions
- **Diagnostics**: GET /v1/sims/{simId}/connectivity-status, GET /v1/sims/{simId}/visited-network, POST /v1/sims/{simId}:cancel-location
- **Billing**: GET /v1/bills, GET /v1/bills/{billId}, GET /v1/bills/{billId}/files
- **Packages**: GET /v1/packages, GET /v1/packages/{packageId}
- **Jobs**: GET /v1/jobs/{jobId}
- **Admin**: 内部管理端点

### 5.2 需新增/增强端点

| 端点 | 方法 | 说明 | 关联 US |
|------|------|------|---------|
| `/v1/resellers` | POST/GET | 代理商管理 | US1 |
| `/v1/resellers/{resellerId}/users` | POST | 代理商用户（路径 `resellerId` = `tenants.tenant_id`，FR-058） | US1 |
| `/v1/enterprises/{id}:change-status` | POST | 企业状态变更 | US1 |
| `/v1/enterprises/{id}/departments` | POST/GET | 部门管理 | US1 |
| `/v1/sims/import-jobs` | POST | SIM 批量导入 | US2 |
| `/v1/sims/{id}:activate` | POST | SIM 激活 | US2 |
| `/v1/sims/{id}:deactivate` | POST | SIM 停机 | US2 |
| `/v1/sims/{id}:reactivate` | POST | SIM 复机 | US2 |
| `/v1/sims/{id}:retire` | POST | SIM 拆机 | US2 |
| `/v1/sims:batch-deactivate` | POST | 批量停机 | US2/US7 |
| `/v1/enterprises/{id}/price-plans` | POST/GET | 资费计划 | US3 |
| `/v1/enterprises/{id}/packages` | POST/GET | 产品包 | US3 |
| `/v1/packages/{id}:publish` | POST | 产品包发布 | US3 |
| `/v1/subscriptions:switch` | POST | 套餐切换 | US4 |
| `/v1/subscriptions/{id}:cancel` | POST | 退订 | US4 |
| `/v1/billing:generate` | POST | 手动出账 | US6 |
| `/v1/bills/{id}:mark-paid` | POST | 人工核销 | US6 |
| `/v1/bills/{id}:adjust` | POST | 调账 | US6 |
| `/v1/enterprises/{id}/overdue-summary` | GET | 企业欠费汇总 | US7 |
| `/v1/reconciliation:run` | POST | 触发对账 | US8 |
| `/v1/alerts` | GET | 告警列表 | US9 |
| `/v1/webhook-subscriptions` | POST/GET | Webhook 管理 | US11 |
| `/v1/events` | GET | 事件查询 | US11 |
| `/v1/upstream-integrations` | GET/POST/PATCH/DELETE | 上游集成配置（Platform Admin，Phase 37/38） | US8 |
| `/v1/upstream-webhook-events` | GET | 入站 Webhook 事件目录（Phase 38，可选 `?adapterType=`） | US8 |
| `/v1/suppliers/{supplierId}/operators/{operatorId}/webhooks/{adapterType}/{eventKey}` | POST | 供应商入站 Webhook（订阅启用 + **webhook_key**；V1.1 `adapterType=wxzhonggeng`） | US11 |
| `/v1/public-infos` | GET | 3GPP 公开运营商目录模糊/精确查询（V1.1，见 `contracts/public-info-api.md`） | US1 |
| `/v1/admin/public-infos` | POST/PATCH/DELETE | 同上目录，仅 platform_admin 写入（V1.1） | US1 |

---

## 5.1 上游集成（Phase 37 + 38）

1. 应用迁移（`npx supabase db push`）：
   - `supabase/migrations/20260523100001_upstream_integrations_v11.sql`（集成表）
   - `supabase/migrations/20260619100001_upstream_inbound_webhook_catalog.sql`（事件目录 + 订阅表）
2. 在 `.env` 设置 **`INTEGRATION_SECRET_KEY`**（≥32 字符，仅用于加密库内 secret，不是上游 API 密钥）。
3. 以 **platform_admin** JWT 调用 **`GET /v1/upstream-webhook-events?adapterType=wxzhonggeng`** 查看可订阅的 **`event_key`** 列表。
4. **`POST /v1/upstream-integrations`** 创建集成（**默认无任何已启用订阅**）：

```json
{
  "supplierId": "<suppliers.supplier_id>",
  "operatorId": "<business_operators.operator_id 或 operators.operator_id>",
  "adapterType": "wxzhonggeng",
  "apiEndpoint": "https://upstream.example.com",
  "apiKey": "...",
  "apiSecret": "...",
  "webhookKey": "..."
}
```

5. **`PATCH /v1/upstream-integrations/{integrationId}`** 逐条启用入站事件（未启用则上游回调 **403** `WEBHOOK_EVENT_NOT_SUBSCRIBED`）：

```json
{
  "subscriptions": [
    { "eventKey": "update-location", "enabled": true },
    { "eventKey": "traffic-alert", "enabled": true }
  ]
}
```

6. **`GET /v1/upstream-integrations/{integrationId}`** 响应中的 **`webhookEndpoints`** 含完整 URL 与 Header **`webhookKey`** 说明；将对应 URL 配置到上游（每条 URL 共用同一 **`webhookKey`**）。
7. Worker / 订阅开通 / SIM 状态 Job 按 **`(supplierId, operatorId)`** 从 DB 加载适配器（**MUST NOT** 依赖 **`WXZHONGGENG_*`** env 业务凭证）。
8. 入站 URL 模板：`POST /v1/suppliers/{supplierId}/operators/{operatorId}/webhooks/wxzhonggeng/{eventKey}`（见 [integration-api.md](./contracts/integration-api.md) §0.5）。

---

## 6. 迁移计划

### 6.1 已有迁移（0001-0018）

| 文件 | 内容 |
|------|------|
| 0001 | 核心表结构（23+ 表, 13 ENUM） |
| 0002-0007 | Golden Case 种子数据与断言 |
| 0004, 0008 | RLS 行级安全策略 |
| 0010-0013 | 账单 API 辅助函数 |
| 0014-0015 | 分享链接 |
| 0016 | jobs.payload JSONB |
| 0017 | usage_daily_summary.updated_at |
| 0018 | sims.upstream_status/upstream_info |

### 6.2 新增迁移（0019-0030）

详见 [data-model.md](./data-model.md) §10 迁移计划。

---

## 7. 关键设计文档

| 文档 | 路径 | 说明 |
|------|------|------|
| 需求规格 | [spec.md](./spec.md) | 11 User Stories, 39 FRs |
| 实施计划 | [plan.md](./plan.md) | 技术上下文与项目结构 |
| 技术研究 | [research.md](./research.md) | 差距分析与风险评估 |
| 数据模型 | [data-model.md](./data-model.md) | 完整表结构与迁移计划 |
| API 契约 | [contracts/](./contracts/) | 5 个模块 API 定义 |
| Golden Cases | [golden_cases.json](../../golden_cases.json) | 计费黄金用例（机器可读） |
| OpenAPI | [iot-cmp-api.yaml](../../iot-cmp-api.yaml) | 现有 64 端点定义 |
| 需求文档 | [CMP_Requirements_Workshop.md](../../CMP_Requirements_Workshop.md) | 原始需求（1523 行） |
