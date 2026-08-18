# 上游集成配置：数据库凭证、API 与 Vendor 适配器

**Feature**: `iot-cmp-reseller` | **Status**: 规范真源（2026-05-19）

## 背景

MVP 阶段曾将 WXZG 等上游凭证放在 **`.env`**（`WXZHONGGENG_URL`、`WXZHONGGENG_API_KEY` 等）以便快速联调。**V1.1 起 MUST 废弃该模式作为生产路径**：上游连接信息 **MUST** 按 **`(reseller_id, supplier_id, operator_id)`** 存入 **`upstream_integrations`**，经 **Platform Admin API**（**platform_admin JWT** 或 **`X-API-Key: ADMIN_API_KEY`**）维护，**Vendor 适配器与 Worker MUST 从数据库读取**。

上游 **产品包 ID** 映射（`vendor_product_mappings` / Package `:publish`）与 **连接凭证** 职责分离；二者共同完成订阅开通与 SIM 生命周期，见 [subscription-provisioning-upstream-mapping.md](./subscription-provisioning-upstream-mapping.md)。

**`operatorId` 解析 MUST** 遵循 [operator-identity-model.md](./operator-identity-model.md)。

---

## 1. 集成粒度

### 1.1 按代理商 + 供应商 + 运营商

- 上游系统 **MAY** 按 **运营商** 提供不同 API 端点与凭证（即使在同一供应商品牌下）。
- 集成配置 **MUST** 以 **`(reseller_id, supplier_id, operators.operator_id)`** 为业务唯一键（ACTIVE/INACTIVE 行上 UNIQUE）。
- 创建集成前 **MUST** 已存在 **`reseller_suppliers`** 绑定（**`POST /v1/resellers/{resellerId}/suppliers`**）；**每个 `supplier_id` 至多绑定一个 Reseller**（**FR-042a**）。`POST /v1/suppliers` **不**携带 `resellerId`。
- **MUST NOT** 使用全局单一 URL/API Key 覆盖所有运营商（MVP `.env` 模式）。

### 1.2 与商业模式的关系

同一 **`business_operators`** 字典运营商 **MAY** 在 **`operators`** 中有多行（不同 `supplier_id`）。每个 **`(reseller, supplier, operator)`** 三元组 **MAY** 有独立的 `upstream_integrations` 记录（不同 URL/Key/WebhookKey）。详见 [operator-identity-model.md](./operator-identity-model.md) §1。

---

## 2. 数据模型 `upstream_integrations`

### 2.1 职责

| 存储内容 | 示例 |
|----------|------|
| 出站 API | `api_endpoint`、`api_key`、`api_secret`（加密）、`token_url`、`auth_type` |
| 入站 Webhook 验签 | `webhook_key` |
| 适配器选择 | `adapter_type`（如 `wxzhonggeng`） |
| CDR（可选） | `cdr_enabled`、`cdr_method`、`cdr_endpoint` 等（对齐 **FR-042**） |
| 扩展参数 | `config` JSONB（endpoint 路径、operation 名等适配器技术参数） |

### 2.2 字段约定（V1.1 目标态）

| 列 | 说明 |
|----|------|
| `integration_id` | PK |
| `reseller_id` | FK → **RESELLER `tenants.tenant_id`** |
| `supplier_id` | FK → `suppliers`（须已绑定该 `reseller_id`） |
| `operator_id` | FK → **`operators.operator_id`**（关联行 PK，**非**字典 ID） |
| `adapter_type` | Vendor 实现标识 |
| `api_endpoint` | 上游 base URL |
| `api_key` | 出站 API Key |
| `api_secret_encrypted` | 出站 Secret（加密 BYTEA） |
| `webhook_key` | 入站 Webhook 验签密钥 |
| `auth_type` | **有效**出站模式（持久化推导值）：`api_key` 或 `username_password` |
| `username` | 出站用户名（可与 api_key 并存，作备用） |
| `password_encrypted` | 出站密码（加密 BYTEA） |
| | **运行时优先级**：`api_key`+`api_secret` 已配置 → 用 api_key；否则 `username`+`password` → 用 username_password；皆无 → 失败 |
| `token_url` | 可选；登录/token 端点覆盖 |
| `enabled` | 是否启用 |
| `config` | JSONB；适配器 endpoint 映射等（**非**业务凭证） |
| `deprecated_at` | 软删时间（`status=DEPRECATED`） |
| `deprecated_by` | 软删操作者（可选） |
| `deprecation_reason` | 软删原因（可选） |
| | **UNIQUE(`reseller_id`, `supplier_id`, `operator_id`) WHERE `status IN ('ACTIVE','INACTIVE')`** |

> **迁移说明**：当前仓库部分迁移仍使用简化列 + `config` JSONB；实现任务 **MUST** 补齐 spec 列并将 `operator_id` FK 校正为 **`operators(operator_id)`**（非 `business_operators`）。

### 2.3 与 `vendor_product_mappings` 的分工

```text
upstream_integrations     →  怎么连上游（URL / Key / WebhookKey / adapter）
vendor_product_mappings   →  连哪个产品（externalProductId）
```

---

## 3. Platform Admin API

### 3.1 路由（Fastify 真源）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/v1/upstream-integrations` | 列表；筛选 `resellerId`、`supplierId`、`operatorId` |
| `POST` | `/v1/upstream-integrations` | 创建（必填 `resellerId`） |
| `GET` | `/v1/upstream-integrations/{integrationId}` | 详情 |
| `PATCH` | `/v1/upstream-integrations/{integrationId}` | 更新 |
| `DELETE` | `/v1/upstream-integrations/{integrationId}` | 软删（置 `DEPRECATED`） |

- **权限**：**platform_admin JWT** 或 **`X-API-Key: ADMIN_API_KEY`**（二者等效平台身份）。
- **OpenAPI**：**MUST** 收录于 `iot-cmp-api.yaml`（`security: BearerAuth | AdminApiKeyAuth`）。
- Express `gapSupplement.js` 中旧实现 **仅为历史**；V1.1 验收以 **Fastify (`src/app.ts`)** 为准。
- `GET /v1/upstream-integrations` 默认仅返回 `ACTIVE` / `INACTIVE`；`DEPRECATED` 历史行用于审计回溯。

### 3.2 请求体示例

```json
{
  "resellerId": "uuid",
  "supplierId": "uuid",
  "operatorId": "uuid",
  "adapterType": "wxzhonggeng",
  "apiEndpoint": "https://upstream.example.com",
  "authType": "api_key",
  "apiKey": "string",
  "apiSecret": "string",
  "webhookKey": "string",
  "enabled": true
}
```

### 3.3 `operatorId` 输入

- 请求/查询中的 **`operatorId` MUST** 按 [operator-identity-model.md](./operator-identity-model.md) §3 双路径解析。
- **MUST** 与 **`supplierId`** 一并提供（创建/筛选时）。
- 持久化 **MUST** 使用解析后的 **`operators.operator_id`**。

### 3.4 Secret 处理

- **`apiSecret` / `webhookKey`**：写入时加密存储；**GET 响应 MUST NOT** 明文回显完整 secret（**MAY** 返回 `hasApiSecret: true` 或尾号掩码）。
- 应用层加密密钥 **MUST** 来自环境变量 **`INTEGRATION_SECRET_KEY`**（**仅**用于加解密，**不是**业务上游凭证）。细则见 §9。

### 3.5 `adapterType` 枚举

- **MUST** 为有限枚举；V1.1 初值：**`wxzhonggeng`**。
- 代码 **MUST** 维护 **adapter registry**（`adapter_type` → 工厂函数）；未知值 → **400** `BAD_REQUEST`。
- 细则与业界对照见 §10。

---

## 4. Vendor 适配器运行时

### 4.1 加载顺序（V1.1）

```text
createSupplierAdapter({ supplierId, operatorId })
  → resolve operator row (§operator-identity-model)
  → SELECT upstream_integrations WHERE supplier_id AND operator_id AND enabled
  → adapter_type → wxzhonggeng | …
  → inject api_endpoint, api_key, api_secret, config
  → outbound HTTP
```

### 4.2 MUST NOT

- **MUST NOT** 从 **`WXZHONGGENG_URL` / `WXZHONGGENG_API_KEY` / `WXZHONGGENG_WEBHOOK_KEY`** 等 **业务凭证** env 读取生产配置。
- **MUST NOT** 仅凭 `supplierId` 创建适配器（缺 `operatorId` 时 **MUST** 失败或从 SIM/Package 上下文补齐）。

### 4.3 调用方

下列路径 **MUST** 传入 **`supplierId` + `operatorId`**（来自 SIM、Package/Carrier Service 或 Job payload）：

- `SUBSCRIPTION_PROVISION` Worker
- SIM 状态变更 / `changePlan` Worker
- 用量同步、对账等南向任务

### 4.4 适配器技术配置

- 各 Vendor 的 **endpoint 路径、响应字段映射** **MAY** 保留在代码或 `config` JSONB（如现有 `wxzhonggeng_config.json` 结构）。
- **凭证与 base URL MUST** 来自 `upstream_integrations`。

---

## 5. 入站供应商 Webhook

> **增强（已评审 · Phase 38）**: 事件目录、集成订阅、`webhookEndpoints` 见 [upstream-inbound-webhook-catalog.md](./upstream-inbound-webhook-catalog.md)。本节为 **Phase 37 已交付** 之路径与验签；订阅校验与默认全关见 Phase 38。

### 5.1 路径

入站 Webhook **MUST** 使用：

```text
POST /v1/suppliers/{supplierId}/operators/{operatorId}/webhooks/{adapterType}/{eventKey}
```

- **`adapterType` MUST** 与集成行 **`upstream_integrations.adapter_type`** 一致（V1.1 枚举值 **`wxzhonggeng`**）。
- **`eventKey`** 为平台事件标识；V1.1 WXZG 固定四条：

```text
POST …/webhooks/wxzhonggeng/update-location
POST …/webhooks/wxzhonggeng/sim-status-changed
POST …/webhooks/wxzhonggeng/traffic-alert
POST …/webhooks/wxzhonggeng/subscription
```

- **`supplierId` + `operatorId`** **MUST** 唯一定位集成与 **`webhook_key`** 验签。
- **MUST NOT** 使用路径别名 **`wx`**（与 `adapter_type` 不一致）。
- **MUST NOT** 提供 MVP 全局路径 **`/v1/wx/webhook/*`**。

### 5.2 路径中的 `operatorId`

- **SHOULD** 使用 **`business_operators.operator_id`（字典 ID）** 配置到上游，便于运维识别。
- 服务端 **MUST** 按 [operator-identity-model.md](./operator-identity-model.md) §3 解析为 **`operators.operator_id`**，再加载 `upstream_integrations` 与 **`webhook_key`** 验签。

### 5.3 为何必须带 `supplierId`

仅字典 `operatorId` 无法区分「同一运营商、不同供应商渠道」的两套上游凭证；**`resellerId` + `supplierId` + `operatorId`** 在 UNIQUE 约束下 **MUST** 唯一定位一条集成记录。

### 5.4 不支持的旧形态

- **MUST NOT** 实现或文档化 **`POST /v1/wx/webhook/*`**（MVP 全局路径）。
- **MUST NOT** 使用全局 **`.env`** 中的 **`WXZHONGGENG_WEBHOOK_KEY`**（或等价变量）作为入站验签真源。
- 无旧客户端兼容义务；运维 **MUST** 仅向上游登记 §5.1 路径。

---

## 6. 环境变量（V1.1）

| 变量 | V1.1 |
|------|------|
| `WXZHONGGENG_URL`、`WXZHONGGENG_API_KEY`、`WXZHONGGENG_API_SECRET`、`WXZHONGGENG_USERNAME`、`WXZHONGGENG_PASSWORD`、`WXZHONGGENG_WEBHOOK_KEY` | **MUST NOT** 作为业务凭证或 Webhook 验签真源；**MUST** 经 **`POST /v1/upstream-integrations`** 写入 DB |
| `WXZHONGGENG_SUPPLIER_ID`、`SUPPLIER_ADAPTERS`、`SUPPLIER_ADAPTERS_JSON`、`SUPPLIER_DEFAULT_ADAPTER`、`UPSTREAM_INTEGRATION_ENV_FALLBACK` | **MUST NOT** 用于适配器路由或 DB 旁路 |
| `INTEGRATION_SECRET_KEY` | **MUST**（生产读写 secret 时）：应用层加解密 master key，**非**上游凭证 |

### 6.1 Diagnostics outbound

Diagnostics 模块（`connectivity-status`、`visited-network*`、`cancel-location`）**MUST** 按 SIM 的 `(supplier_id, operator_id)` 加载本表集成行并调用 adapter；**MUST NOT** 使用 §6 所列 WXZHONGGENG env 作为出站真源。能力与字段映射见 [diagnostics-upstream-capabilities.md](./diagnostics-upstream-capabilities.md)。

---

## 7. 错误码（摘要）

| HTTP | code | 说明 |
|------|------|------|
| 400 | `BAD_REQUEST` | `operatorId` 无法解析或未绑定 `supplierId` |
| 400 | `SUPPLIER_NOT_BOUND` | `supplierId` 未通过 `reseller_suppliers` 绑定到请求的 `resellerId` |
| 404 | `NOT_FOUND` | 无匹配集成记录 |
| 409 | `DUPLICATE` / `CONFLICT` | `(resellerId, supplierId, operatorId)` UNIQUE 冲突 |
| 503 | `UPSTREAM_NOT_CONFIGURED` | 集成存在但 `enabled=false` 或缺必填凭证 |

---

## 9. 凭证加密（FAQ）

### 9.1 为何要加密存 DB？

`api_secret`、`webhook_key` 为**上游账号级敏感信息**。明文存 DB 时，备份泄露、误查询、日志即等于凭证泄露。Spec 要求 **`api_secret_encrypted BYTEA`**（**FR-042**）。

### 9.2 `INTEGRATION_SECRET_KEY` 与上游 API Secret 的区别

| 密钥 | 归属 | 用途 |
|------|------|------|
| **上游 `api_secret`** | 上游供应商签发 | 调用上游 HTTP API |
| **`INTEGRATION_SECRET_KEY`** | CMP 应用自身（env） | 加解密 DB 中的 secret 字段 |

**MUST NOT** 混淆：V1.1 废弃的是 **`WXZHONGGENG_API_SECRET`** 等业务 env；**允许**保留 **`INTEGRATION_SECRET_KEY`** 作为基础设施密钥（类比 `AUTH_TOKEN_SECRET`）。

### 9.3 加密方案（V1.1 实现约定）

- 算法：**AES-256-GCM**（认证加密）。
- 密钥：自 **`INTEGRATION_SECRET_KEY`** 派生 32 字节 key（如 SHA-256 或 HKDF）。
- 存储：`BYTEA` = **`iv (12B) || ciphertext || authTag`**（或等价 ASN.1/JSON 包装，实现统一即可）。
- **`webhook_key`**：**SHOULD** 同样加密存 **`webhook_key_encrypted BYTEA`**，或单列明文仅当 RLS+不回显已足够（V1.1 推荐与 `api_secret` 一致加密）。
- 运行时：解密**仅在内存**中用于 HTTP 请求 / 验签；**MUST NOT** 写入日志或 API 响应。
- 启动：生产环境缺 **`INTEGRATION_SECRET_KEY`** 且需读写 secret 时 **MUST** 失败 fast（或拒绝 POST/PATCH 含 secret 的请求）。

### 9.4 密钥轮换（后续）

Master key 轮换需对 `upstream_integrations` 全表重加密；V1.1 **MAY** 文档化流程，**MAY** 单列 `secret_key_version` 供后续扩展。

---

## 10. `adapterType` 设计依据（FAQ）

### 10.1 为何不靠 `supplierId` 猜适配器？

| 字段 | 含义 |
|------|------|
| **`supplierId`** | 商业主体：「跟哪家供应商做生意」 |
| **`adapterType`** | 技术实现：「用哪套协议/代码对接」 |

MVP 用 **`WXZHONGGENG_SUPPLIER_ID`** / **`SUPPLIER_ADAPTERS`** 把 UUID 映射到 `wxzhonggeng`，等价于把 **adapter 选择写在部署配置里**。V1.1 目标是把 **连接参数 + 适配器类型** 一并放入 DB，由 Platform Admin 维护，**无需改 env 或发版**即可接入新 `(supplier, operator)` 集成。

### 10.2 业界常见模式（Connector Registry）

| 产品/领域 | 类似字段 |
|-----------|----------|
| iPaaS / Zapier | Connector type |
| 支付 | Payment provider / driver |
| 身份 | IdP provider (`google`, `azure_ad`) |
| 多云 / IoT | Adapter / plugin name |

共同结构：**业务身份 + connector/adapter 类型 + 连接凭证**。本项目的 **`adapter_type`** 即 connector type。

### 10.3 实现约束

- DB 中 **`adapter_type` 为字符串枚举**；仅**已实现**的 adapter 可写入。
- 新增上游协议 = 新增 adapter 实现 + 注册枚举值 + 文档；**非**仅改 DB 一行即可运行。
- **`config` JSONB** 存放该 adapter 的可选技术参数（endpoint 路径等）；**凭证 MUST NOT** 仅藏在 `config` 明文里。

---

## 8. 相关文档

- [diagnostics-upstream-capabilities.md](./diagnostics-upstream-capabilities.md) — Diagnostics 四条 API：Integration 绑定、adapter 能力矩阵、WXZG 本地拼装（**已评审 · 2026-06-17**）
- [upstream-inbound-webhook-catalog.md](./upstream-inbound-webhook-catalog.md) — 入站事件目录与集成订阅（初步方案）
- [operator-identity-model.md](./operator-identity-model.md)
- [subscription-provisioning-upstream-mapping.md](./subscription-provisioning-upstream-mapping.md)
- [spec.md](../spec.md) — **FR-042**、**FR-064**～**FR-066**、**FR-067**～**FR-070**（草案）
- [data-model.md](../data-model.md) — `upstream_integrations` 表
