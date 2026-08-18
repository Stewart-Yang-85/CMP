# API 契约：集成、事件与可观测性

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08
**关联 User Story**: US8（上游对账）、US9（监控诊断）、US10（虚拟化层）、US11（事件架构）
**关联需求**: FR-035 ~ FR-039

> **FR-058**：本文档中 **去重键、事件与查询** 涉及的 `resellerId` 均指 **RESELLER `tenants.tenant_id`**（与 JWT / OpenAPI 一致）。详见 [tenant-api.md §0](tenant-api.md)。

> **Package / 订阅标识**：事件、Webhook 载荷与 HTTP 请求体中的产品包字段统一为 **`packageId`**（UUID = `public.packages.package_id`）；旧产品包版本兼容别名不再属于当前契约。

> **上游集成与运营商 ID**：**`operatorId`** 解析、**`adapterType`**、凭证加密见 [operator-identity-model.md](../clarifications/operator-identity-model.md)、[upstream-integration-config.md](../clarifications/upstream-integration-config.md)。**FR-064**～**FR-066**。  
> **入站事件目录与集成订阅（初步方案 · 待评审）**: [upstream-inbound-webhook-catalog.md](../clarifications/upstream-inbound-webhook-catalog.md)。

---

## 0. 上游集成配置（Platform Admin / Admin API Key）

**Clarifications 真源**: [upstream-integration-config.md](../clarifications/upstream-integration-config.md)

> **唯一键**：ACTIVE/INACTIVE 行 **`UNIQUE(resellerId, supplierId, operatorId)`**（**FR-042**）。  
> **绑定前置**：创建前 `supplierId` **MUST** 已通过 **`POST /v1/resellers/{resellerId}/suppliers`** 绑定到该 `resellerId`；每个 supplier **至多一个** reseller（**FR-042a**）。  
> **鉴权**：**platform_admin JWT** 或 **`X-API-Key: ADMIN_API_KEY`**。

### 0.1 列表

```
GET /v1/upstream-integrations?resellerId={}&supplierId={}&operatorId={}&status={}&page=1&pageSize=20
```

**权限**: platform_admin JWT **或** ADMIN_API_KEY

**Query**:
- `resellerId`、`supplierId`、`operatorId`（可选筛选）；`supplierId` 须为已存在供应商，否则 **404** `SUPPLIER_NOT_FOUND`
- `status`（可选）：`ACTIVE` | `INACTIVE` | `DEPRECATED`；**省略**时返回 `ACTIVE` + `INACTIVE`（默认不列已软删）
- `page`（默认 **1**）、`pageSize`（默认 **20**，最大 200）

**Response 200**:
```json
{
  "items": [
    {
      "integrationId": "uuid",
      "resellerId": "uuid",
      "supplierId": "uuid",
      "operatorId": "uuid",
      "adapterType": "wxzhonggeng",
      "apiEndpoint": "https://upstream.example.com",
      "apiKey": "string",
      "hasApiSecret": true,
      "hasWebhookKey": true,
      "authType": "api_key",
      "enabled": true,
      "createdAt": "2026-05-19T10:00:00Z",
      "updatedAt": "2026-05-19T10:00:00Z"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

- 响应 **`operatorId`**：**SHOULD** 优先为 **`business_operators.operator_id`**（字典 ID）。
- **`apiSecret` / `webhookKey`**：**MUST NOT** 明文回显。

### 0.2 创建

```
POST /v1/upstream-integrations
```

**Request Body**:
```json
{
  "resellerId": "uuid (required — RESELLER tenants.tenant_id)",
  "supplierId": "uuid (required — 须已绑定该 resellerId)",
  "operatorId": "uuid (required — 字典 ID 或 operators 行 PK)",
  "adapterType": "wxzhonggeng (required)",
  "name": "string (required — 非空，不可为 null 或 \"\")",
  "apiEndpoint": "string (required — 合法 http/https URL，不可为 null 或 \"\")",
  "authType": "api_key | username_password (可选；响应为按优先级推导的有效模式)",
  "apiKey": "string (与 apiSecret 成对；可与 username/password 同时保存)",
  "apiSecret": "string (与 apiKey 成对)",
  "username": "string (与 password 成对；无 apiKey 时用于出站)",
  "password": "string (与 username 成对)",
  "webhookKey": "string (required — 非空)",
  "tokenUrl": "string (optional — 登录/token 端点覆盖)",
  "enabled": true
}
```

**Response 201**: 同列表项结构。

**错误**: **400** operator 无法解析；**400** `name` / `apiEndpoint` / `webhookKey` 缺失或非法；**400** 出站凭证不足（须至少完整一对：`apiKey`+`apiSecret` 或 `username`+`password`）；**400** 凭证半套（如仅有 apiKey 无 apiSecret）；**409** `(supplierId, operatorId)` 已存在。**出站优先级**：已配置 `apiKey`+`apiSecret` → 使用 `api_key`；否则已配置 `username`+`password` → 使用 `username_password`；两者皆无 → 400。可同时保存两套，Adapter 按上述优先级选用。

### 0.3 更新 / 删除

```
PATCH /v1/upstream-integrations/{integrationId}
DELETE /v1/upstream-integrations/{integrationId}
```

- **PATCH**：部分更新；传入 **`apiSecret`** / **`webhookKey`** 时重新加密存储。**仅** `status` 为 `ACTIVE` 或 `INACTIVE` 的行可更新；`DEPRECATED` 返回 **409** `INVALID_STATUS`（避免与新建集成并存两条 ACTIVE 配置）。
- **DELETE（V1.1）**：**软删**（非物理删除）：
  - `status` -> `DEPRECATED`
  - `enabled` -> `false`
  - 写入 `deprecatedAt`；可选请求体 **`deprecationReason`**、**`deprecatedBy`**（未传 `deprecatedBy` 时用 JWT `sub`/userId，如 `cmp-admin`）
  - 已是 `DEPRECATED` 再删 → **409** `INVALID_STATUS`
  - 同时关闭该集成下所有入站事件订阅（`upstream_integration_webhook_subscriptions.enabled=false`）
- **列表默认过滤**：省略 `status` 时仅返回 `ACTIVE` / `INACTIVE`；查历史软删行传 `status=DEPRECATED`。

### 0.4 入站供应商 Webhook（路径模板）

```
POST /v1/suppliers/{supplierId}/operators/{operatorId}/webhooks/{adapterType}/{eventKey}
```

V1.1（`adapterType` = **`wxzhonggeng`**）：

```
POST …/webhooks/wxzhonggeng/update-location
POST …/webhooks/wxzhonggeng/sim-status-changed
POST …/webhooks/wxzhonggeng/traffic-alert
POST …/webhooks/wxzhonggeng/subscription
```

- 路径 **`operatorId`**：**SHOULD** 为字典 ID；服务端双路径解析（同 Carrier Service）。
- 验签：HTTP Header **`webhookKey`**（与创建集成时的 **`webhookKey`** 相同）。
- **MUST NOT** 提供 **`/v1/wx/webhook/*`** 或全局 env Webhook Key。

### 0.5 入站事件目录与集成订阅（已评审 · Phase 38）

**Clarifications 真源**: [upstream-inbound-webhook-catalog.md](../clarifications/upstream-inbound-webhook-catalog.md)（§8 决策）

- **事件目录**: `GET /v1/upstream-webhook-events` — 迁移种子维护的 **`event_key`** 列表；**MAY** `?adapterType=` 过滤 adapter 能力子集。
- **集成订阅**: 表 **`upstream_integration_webhook_subscriptions`**；**POST 集成默认无订阅**；**PATCH** 或子资源逐条 **`enabled=true`**；详情 **`webhookEndpoints[]`**（仅已启用事件）。
- **未订阅**: **`403`**、`WEBHOOK_EVENT_NOT_SUBSCRIBED`、**audit_logs**。
- **Phase 37 过渡期**: 四条 WXZG 路径在 Phase 38 完成前仍为隐式全开；完成后以订阅为准。

---

## 1. 连接状态与诊断

> **Clarifications 真源**: [diagnostics-upstream-capabilities.md](../clarifications/diagnostics-upstream-capabilities.md) — Integration 绑定、adapter 能力矩阵（`UPSTREAM_PARTIAL` / `LOCAL_ASSEMBLE` / `NOT_SUPPORTED`）、WXZG 字段映射与本地拼装。

### 1.1 查询 SIM 连接状态

```
GET /v1/sims/{simId}/connectivity-status
```

**权限**: 代理商角色 | 企业角色（所属部门）

**Response 200**:
```json
{
  "iccid": "89860012345678901234",
  "onlineStatus": "ONLINE | OFFLINE",
  "registrationStatus": "REGISTERED_HOME | REGISTERED_ROAMING | NOT_REGISTERED | DENIED",
  "lastActiveTime": "2026-02-08T09:55:00Z",
  "ipAddress": "10.0.0.1",
  "ratType": "4G",
  "servingCellId": "460-00-1234-5678",
  "servingMccMnc": "460-00",
  "apn": "cmiot",
  "sessionUptime": 3600
}
```

**说明**: 数据通过上游供应商 API 代理获取（非信令级直连）。各供应商能力不同；WXZG 仅 **`queryCardStatus`** 提供部分字段，其余由本地 CDR/Webhook 拼装，见 clarifications。

### 1.2 取消位置（强迫 UE 重新附着）

```
POST /v1/sims/{simId}:cancel-location
```

**权限**: 代理商管理员 | 企业管理员
**异步**: 返回 jobId

**Request Body**:
```json
{
  "reason": "string (optional)",
  "idempotencyKey": "string (optional)"
}
```

**Response 202**:
```json
{
  "jobId": "uuid",
  "simId": "uuid",
  "message": "Cancel location request submitted"
}
```

### 1.3 查询 SIM 拜访地网络

```
GET /v1/sims/{simId}/visited-network
```

**权限**: 代理商管理员 | 企业管理员（敏感数据，审计记录）

**Response 200**:
```json
{
  "iccid": "string",
  "locationType": "CELL_BASED | GPS",
  "latitude": 39.9042,
  "longitude": 116.4074,
  "accuracy": 500,
  "timestamp": "2026-02-08T10:00:00Z",
  "cellInfo": {
    "mcc": "460",
    "mnc": "00",
    "lac": "1234",
    "cellId": "5678"
  }
}
```

### 1.4 查询 SIM 拜访地网络附着记录

```
GET /v1/sims/{simId}/visited-network-records?from={from}&to={to}&page={}&pageSize={}
```

**权限**: 代理商管理员（敏感数据，需审计）

---

## 2. 告警管理

### 2.1 查询告警列表

```
GET /v1/alerts?resellerId={}&enterpriseId={}&alertType={}&from={}&to={}&acknowledged={}&page={}&pageSize={}
```

**权限**: 代理商角色 | 企业角色

**Query Parameters**:
| 参数 | 类型 | 说明 |
|------|------|------|
| resellerId | uuid | 代理商筛选；reseller token 只能为空或等于 token scope |
| enterpriseId | uuid | 企业筛选 |
| alertType | string | POOL_USAGE_HIGH / OUT_OF_PROFILE_SURGE / SILENT_SIM / UNEXPECTED_ROAMING / CDR_DELAY / UPSTREAM_DISCONNECT / WEBHOOK_DELIVERY_FAILED |
| from / to | datetime | 时间范围 |
| acknowledged | boolean | 是否已确认 |
| page / pageSize | integer | 分页；V1.1 pageSize 最大 1000 |

**Response 200**:
```json
{
  "items": [
    {
      "alertId": "uuid",
      "alertType": "UNEXPECTED_ROAMING",
      "severity": "P2",
      "status": "OPEN",
      "ruleKey": "roaming.profile.mismatch",
      "enterpriseId": "uuid",
      "simId": "uuid",
      "iccid": "string",
      "threshold": null,
      "currentValue": "424-02",
      "message": "SIM detected in unexpected roaming zone UAE (424-02)",
      "windowStart": "2026-02-08T10:00:00Z",
      "windowEnd": "2026-02-08T11:00:00Z",
      "acknowledged": false,
      "acknowledgedAt": null,
      "createdAt": "2026-02-08T10:05:00Z"
    }
  ],
  "total": 25,
  "page": 1,
  "pageSize": 50
}
```

**告警去重键**: `resellerId + simId + alertType + windowStart`（其中 `resellerId` 为 **RESELLER `tenants.tenant_id`** — **FR-058**）
**告警抑制**: 同一 SIM + 同一类型，N 分钟内仅产生一次告警

### 2.2 确认告警

```
POST /v1/alerts/{alertId}:acknowledge
```

### 2.3 告警统计

```
GET /v1/alerts/summary?from={}&to={}&severity={}&alertType={}
```

**Response 200**:
```json
{
  "totalOpen": 1200,
  "byStatus": [
    { "status": "OPEN", "count": 1200 },
    { "status": "ACKED", "count": 30 },
    { "status": "RESOLVED", "count": 10 },
    { "status": "SUPPRESSED", "count": 0 }
  ],
  "bySeverity": [
    { "severity": "P0", "count": 2 },
    { "severity": "P1", "count": 18 },
    { "severity": "P2", "count": 240 },
    { "severity": "P3", "count": 940 }
  ]
}
```

### 2.4 告警趋势

```
GET /v1/alerts/trends?days={}&alertType={}&severity={}
```

**Response 200**:
```json
{
  "days": 7,
  "trends": [
    { "date": "2026-02-08", "count": 12 },
    { "date": "2026-02-09", "count": 8 }
  ]
}
```

### 2.5 告警规则配置

```
GET /v1/alert-configs?scopeType={}&resellerId={}&enterpriseId={}&alertType={}&page={}&pageSize={}
POST /v1/alert-configs
PATCH /v1/alert-configs/{configId}
GET /v1/alert-configs/effective?alertType={}&resellerId={}&enterpriseId={}
```

**权限**: 平台管理员 | 代理商管理员；effective 查询也可由企业 token 按自身 scope 查询。

**规则**:
- `PLATFORM` 配置仅平台管理员维护。
- reseller token 创建/更新时，`resellerId` 自动收敛到 token scope；不得维护 `PLATFORM` 配置。
- `ENTERPRISE` 配置必须隶属于指定 `RESELLER`。
- 有效配置解析顺序为 `ENTERPRISE` → `RESELLER` → `PLATFORM` → built-in；更具体 scope 的 `enabled=false` 会阻断上层配置。

**Request Body**:
```json
{
  "scopeType": "RESELLER",
  "resellerId": "uuid",
  "enterpriseId": null,
  "alertType": "POOL_USAGE_HIGH",
  "enabled": true,
  "severity": "P2",
  "thresholdValue": 80,
  "thresholdUnit": "PERCENT",
  "windowMinutes": 60,
  "suppressMinutes": 30,
  "deliveryChannels": ["PORTAL"],
  "deliveryTargets": {}
}
```

**Response 200**:
```json
{
  "configId": "uuid",
  "scopeType": "RESELLER",
  "resellerId": "uuid",
  "enterpriseId": null,
  "alertType": "POOL_USAGE_HIGH",
  "enabled": true,
  "severity": "P2",
  "thresholdValue": 80,
  "thresholdUnit": "PERCENT",
  "windowMinutes": 60,
  "suppressMinutes": 30,
  "deliveryChannels": ["PORTAL"],
  "deliveryTargets": {},
  "version": 1
}
```

---

## 3. Webhook 管理

### 3.1 创建 Webhook 订阅

```
POST /v1/webhook-subscriptions
```

**权限**: 代理商管理员 | 企业管理员

**Request Body**:
```json
{
  "url": "string (required, HTTPS)",
  "eventTypes": [
    "SIM_STATUS_CHANGED",
    "JOB_FINISHED",
    "SUBSCRIPTION_CHANGED",
    "BILL_PUBLISHED",
    "PAYMENT_CONFIRMED",
    "ALERT_TRIGGERED",
    "ENTERPRISE_STATUS_CHANGED"
  ],
  "secret": "string (required, 用于 HMAC-SHA256 签名验证)",
  "enabled": true,
  "description": "string (optional)"
}
```

**Response 201**:
```json
{
  "subscriptionId": "uuid",
  "url": "https://example.com/webhooks",
  "eventTypes": [...],
  "enabled": true,
  "createdAt": "2026-02-08T10:00:00Z"
}
```

### 3.2 Webhook 投递格式

**HTTP Headers**:
```
Content-Type: application/json
X-Webhook-Signature: sha256=<HMAC-SHA256(body, secret)>
X-Webhook-Timestamp: 1707350400
X-Webhook-Event: SIM_STATUS_CHANGED
X-Webhook-Delivery-Id: 123456
```

**Request Body**:
```json
{
  "eventId": "uuid",
  "eventType": "SIM_STATUS_CHANGED",
  "occurredAt": "2026-02-08T10:00:00Z",
  "tenantId": "uuid",
  "resellerId": "uuid",
  "resellerRecordId": "uuid",
  "actorUserId": "uuid",
  "payload": {
    "simId": "uuid",
    "iccid": "string",
    "beforeStatus": "INVENTORY",
    "afterStatus": "ACTIVATED",
    "supplierId": "uuid"
  },
  "requestId": "string",
  "jobId": "string | null"
}
```

#### `JOB_FINISHED`（[V1.1] SIM 生命周期 Job 终态）

**触发时机**：`jobs.type = SIM_STATUS_CHANGE` 进入终态 **`SUCCEEDED`** 或 **`FAILED`**（上游确认并改库成功，或失败/拒绝/适配器判定失败）。

**不触发**：Job 仍为 `QUEUED` / `RUNNING`；首包 202 受理时。

**与 `SIM_STATUS_CHANGED` 分工**：

| 事件 | 何时发 | 典型用途 |
|------|--------|----------|
| `SIM_STATUS_CHANGED` | 本地 **`status` 稳态**已变更且 `lifecycleSubStatus=normal` | 计费、编排以卡状态为准 |
| `JOB_FINISHED` | Job 终态 | 以 Job 为中心的异步回调；**失败时可能没有** `SIM_STATUS_CHANGED` |

**HTTP Headers**：`X-Webhook-Event: JOB_FINISHED`

**Request Body**:
```json
{
  "eventId": "uuid",
  "eventType": "JOB_FINISHED",
  "occurredAt": "2026-02-08T10:00:05Z",
  "tenantId": "uuid",
  "resellerId": "uuid",
  "actorUserId": "uuid",
  "payload": {
    "jobId": "uuid",
    "jobType": "SIM_STATUS_CHANGE",
    "jobStatus": "SUCCEEDED",
    "action": "ACTIVATE",
    "simId": "uuid",
    "iccid": "89860012345678901234",
    "beforeStatus": "TEST_READY",
    "targetStatus": "ACTIVATED",
    "resultStatus": "ACTIVATED",
    "lifecycleSubStatus": "normal",
    "errorCode": null,
    "errorSummary": null
  },
  "requestId": "string",
  "jobId": "uuid"
}
```

**`jobStatus=FAILED` 时** `payload` **SHOULD** 含 `errorCode` / `errorSummary`，`resultStatus` 为源稳态，`lifecycleSubStatus` 为对应 `*_failed`（如 `activation_failed`）。

**出站签名校验**:
- 使用订阅 `secret` 对原始 HTTP body 字符串进行 HMAC-SHA256 计算
- Header `X-Webhook-Signature` 固定为 `sha256=<hex>` 形式
- 接收方应使用原始 body（不做 JSON 重排）计算并比较签名

- `tenantId`：事件租户上下文；与 **代理商** 订阅相关时，与 **RESELLER `tenants.tenant_id`** / JWT `resellerId`（**FR-058**）一致（详见 [tenant-api.md §0](tenant-api.md)）。
- `resellerId`（顶层，若存在）： owning **RESELLER `tenants.tenant_id`**（**FR-058**），与 `payload.resellerId` 对齐（服务端写入）。
- `resellerRecordId`（顶层，可选）：`resellers.id`，便于运营与库行对账。

**重放保护**: 接收方应验证 `X-Webhook-Timestamp` 在 5 分钟内

**投递重试**: 指数退避（2s, 4s, 8s），至少 3 次，最终失败进入死信队列

### 3.3 查询 Webhook 投递记录

```
GET /v1/webhook-subscriptions/{subscriptionId}/deliveries?status={}&page={}&pageSize={}
```

- `page` 默认 **1**；`pageSize` 默认 **50**，最大 **100**
- 响应包含 `items`、`total`、`page`、`pageSize`

### 3.4 重试投递

```
POST /v1/webhook-deliveries/{deliveryId}:retry
```

---

## 4. 事件查询

**FR-058（事件 `payload`）**：凡字段名为 `resellerId`，值均为 **RESELLER `tenants.tenant_id`**。经 `emitEvent` 写入的域事件会在 `payload` 中补齐 `resellerId`（由 `events.tenant_id` 解析代理商父租户）；Webhook 投递体另含顶层 `resellerId` / 可选 `resellerRecordId`，与实现一致。

### 4.1 查询事件列表

```
GET /v1/events?eventCategory={}&eventType={}&resellerId={}&iccid={}&from={}&to={}&page={}&pageSize={}
GET /v1/events/catalog
```

**权限**: 系统管理员 | 代理商管理员

**Query Parameters**:
| 参数 | 说明 |
|------|------|
| resellerId | 可选；按 **RESELLER `tenants.tenant_id`**（**FR-058**）收窄事件范围。reseller token 不传时默认 token reseller，传入必须与 token 匹配；customer token 忽略该参数；platform/admin 可与 `enterpriseId` 同传并校验归属 |
| enterpriseId | 可选；按 **ENTERPRISE `tenants.tenant_id`** 收窄事件范围。reseller token 不传时查询该 reseller 下所有企业，传入时必须归属该 reseller；customer token 不传时默认 token enterprise，传入时必须与 token 匹配；platform/admin 可与 `resellerId` 同传并校验归属 |
| eventCategory | 可选；短枚举大类（`webhook` / `billing` / `sim` / `inbound` / `subscription`），展开为多条 `event_type`；映射见 **`GET /v1/events/catalog`**（`upstream` 为已废弃别名，等同 `inbound`） |
| eventType | 可选；精确 `event_type`；与 `eventCategory` 同传时须属于该大类 |
| iccid | 可选；先校验 ICCID 格式、`sims` 表存在性与租户归属，再按事件 `payload.iccid` 精确过滤；不存在返回 `SIM_NOT_FOUND`，reseller/customer 越权返回 `FORBIDDEN` |
| from / to / page / pageSize | 与实现及 OpenAPI 一致 |

**Response 200**:
```json
{
  "items": [
    {
      "eventId": "uuid",
      "eventType": "SIM_STATUS_CHANGED",
      "occurredAt": "2026-02-08T10:00:00Z",
      "tenantId": "uuid",
      "actorUserId": "uuid",
      "payload": { ... },
      "requestId": "string",
      "jobId": "string | null"
    }
  ],
  "total": 1000
}
```

### 4.2 事件目录

| eventType | 触发条件 | payload 最小字段 | 去重键 |
|-----------|---------|-----------------|--------|
| `SIM_STATUS_CHANGED` | SIM **稳态** `status` 变更（上游确认并改库后） | simId, iccid, beforeStatus, afterStatus, supplierId, lifecycleSubStatus=normal | resellerId（**`tenants.tenant_id`**, **FR-058**）+simId+afterStatus+occurredAt(1min) |
| `JOB_FINISHED` | `SIM_STATUS_CHANGE` Job 终态 SUCCEEDED/FAILED | jobId, jobType, jobStatus, action, simId, iccid, beforeStatus, targetStatus, resultStatus, lifecycleSubStatus, errorCode | jobId+jobStatus |
| `SUBSCRIPTION_CHANGED` | 订阅创建/变更/退订 | subscriptionId, simId, packageId, beforeState, afterState, effectiveAt | resellerId（同上）+subscriptionId+afterState+effectiveAt |
| `BILL_PUBLISHED` | 账单发布 | billId, customerId, period, totalAmount, dueDate | customerId+billId |
| `PAYMENT_CONFIRMED` | 支付确认 | billId, customerId, paidAmount, paidAt, paymentRef | customerId+billId+paymentRef |
| `ALERT_TRIGGERED` | 告警触发 | alertType, customerId, simId, threshold, currentValue, windowStart | resellerId（**`tenants.tenant_id`**, **FR-058**）+simId+alertType+windowStart |
| `ENTERPRISE_STATUS_CHANGED` | 企业状态变更 | enterpriseId, beforeStatus, afterStatus, reason | enterpriseId+afterStatus+occurredAt(1min) |

---

## 5. 上游对账（Reconciliation）

### 5.1 触发对账

```
POST /v1/reconciliation/runs
```

**权限**: 系统管理员

**Request Body**:
```json
{
  "supplierId": "uuid (required)",
  "date": "string (required, e.g. '2026-02-08')",
  "scope": "FULL | INCREMENTAL (default INCREMENTAL)"
}
```

**Response 202**:
```json
{
  "runId": "uuid",
  "jobId": "uuid | null",
  "status": "RUNNING"
}
```

### 5.2 查询对账任务列表

```
GET /v1/reconciliation/runs
```

**Query**:
```
supplierId, date(YYYY-MM-DD), scope(FULL|INCREMENTAL), status(RUNNING|COMPLETED|FAILED), page, pageSize
```

**Response 200**:
```json
{
  "items": [
    {
      "runId": "uuid",
      "supplierId": "uuid",
      "date": "2026-02-08",
      "scope": "INCREMENTAL",
      "status": "COMPLETED",
      "summary": {
        "totalSimsChecked": 50000,
        "matched": 49950,
        "mismatched": 50,
        "localOnly": 5,
        "upstreamOnly": 3
      },
      "startedAt": "2026-02-08T10:00:00Z",
      "completedAt": "2026-02-08T10:30:00Z"
    }
  ],
  "total": 100,
  "page": 1,
  "pageSize": 20
}
```

### 5.3 查询对账结果

```
GET /v1/reconciliation/runs/{runId}
```

**Response 200**:
```json
{
  "runId": "uuid",
  "supplierId": "uuid",
  "date": "2026-02-08",
  "status": "COMPLETED",
  "summary": {
    "totalSimsChecked": 50000,
    "matched": 49950,
    "mismatched": 50,
    "localOnly": 5,
    "upstreamOnly": 3
  },
  "mismatches": [
    {
      "iccid": "string",
      "simId": "uuid",
      "enterpriseId": "uuid | null",
      "supplierId": "uuid",
      "carrierId": "uuid | null",
      "field": "status",
      "localValue": "ACTIVATED",
      "upstreamValue": "DEACTIVATED",
      "upstreamStatusUpdatedAt": "2026-02-08T09:30:00Z",
      "resolution": "UPSTREAM_WINS",
      "resolvedAt": "2026-02-08T11:00:00Z"
    }
  ],
  "metrics": {
    "total": 50,
    "byField": { "status": 50 },
    "byResolution": { "UPSTREAM_WINS": 50 },
    "byLocalStatus": { "ACTIVATED": 30 },
    "byUpstreamStatus": { "DEACTIVATED": 20 },
    "byStatusPair": { "ACTIVATED->DEACTIVATED": 20 },
    "byEnterpriseId": { "uuid": 10 },
    "bySupplierId": { "uuid": 50 },
    "byCarrierId": { "uuid": 12 }
  },
  "completedAt": "2026-02-08T10:30:00Z"
}
```

**对账规则**: 以上游为准（UPSTREAM_WINS），本系统记录差异用于稽核分析
**metrics 说明**: 汇总 mismatches 列表中的差异分布，支持按供应商与运营商维度观察

### 5.4 查询对账差异列表

```
GET /v1/reconciliation/runs/{runId}/mismatches
```

**Query**:
```
field, resolution, iccid, enterpriseId, page, pageSize
```

**Response 200**:
```json
{
  "items": [
    {
      "iccid": "string",
      "simId": "uuid",
      "enterpriseId": "uuid | null",
      "supplierId": "uuid",
      "carrierId": "uuid | null",
      "field": "status",
      "localValue": "ACTIVATED",
      "upstreamValue": "DEACTIVATED",
      "upstreamStatusUpdatedAt": "2026-02-08T09:30:00Z",
      "resolution": "UPSTREAM_WINS",
      "resolvedAt": "2026-02-08T11:00:00Z"
    }
  ],
  "total": 50,
  "page": 1,
  "pageSize": 20,
  "metrics": {
    "total": 50,
    "byField": { "status": 50 },
    "byResolution": { "UPSTREAM_WINS": 50 },
    "byLocalStatus": { "ACTIVATED": 30 },
    "byUpstreamStatus": { "DEACTIVATED": 20 },
    "byStatusPair": { "ACTIVATED->DEACTIVATED": 20 },
    "byEnterpriseId": { "uuid": 10 },
    "bySupplierId": { "uuid": 50 },
    "byCarrierId": { "uuid": 12 }
  }
}
```

### 5.5 对账差异回溯

```
GET /v1/reconciliation/runs/{runId}/mismatches/{iccid}/trace
```

**Response 200**:
```json
{
  "run": {
    "runId": "uuid",
    "date": "2026-02-08",
    "scope": "INCREMENTAL",
    "status": "COMPLETED",
    "startedAt": "2026-02-08T10:00:00Z",
    "completedAt": "2026-02-08T10:30:00Z"
  },
  "mismatch": {
    "iccid": "string",
    "field": "status",
    "localValue": "ACTIVATED",
    "upstreamValue": "DEACTIVATED",
    "resolution": "UPSTREAM_WINS",
    "resolvedAt": "2026-02-08T11:00:00Z"
  },
  "sim": {
    "simId": "uuid",
    "iccid": "string",
    "status": "DEACTIVATED",
    "upstreamStatus": "DEACTIVATED",
    "upstreamStatusUpdatedAt": "2026-02-08T09:30:00Z",
    "enterpriseId": "uuid | null",
    "departmentId": "uuid | null",
    "supplierId": "uuid | null",
    "carrierId": "uuid | null"
  },
  "simStateHistory": [],
  "events": [],
  "audits": []
}
```

---

## 6. 供应商适配器 SPI（内部接口）

### 6.1 ProvisioningSPI

```typescript
interface ProvisioningSPI {
  activateSim(params: {
    iccid: string;
    idempotencyKey: string;
  }): Promise<ProvisioningResult>;

  suspendSim(params: {
    iccid: string;
    idempotencyKey: string;
  }): Promise<ProvisioningResult>;

  changePlan(params: {
    iccid: string;
    externalProductId: string;
    effectiveAt?: Date;
    idempotencyKey: string;
  }): Promise<ProvisioningResult>;
}
```

### 6.2 UsageSPI

```typescript
interface UsageSPI {
  getDailyUsage(params: {
    iccid: string;
    date: string;
  }): Promise<UsageRecord[]>;

  fetchCdrFiles(params: {
    supplierId: string;
    date: string;
    protocol: 'SFTP' | 'API';
  }): Promise<CdrFileResult>;
}
```

### 6.3 CatalogSPI

```typescript
interface CatalogSPI {
  mapVendorProduct(params: {
    supplierId: string;
    externalProductId: string;
  }): Promise<VendorProductMapping>;
}
```

### 6.4 Capability Negotiation

```typescript
interface SupplierCapabilities {
  supportsFutureDatedChange: boolean;
  supportsRealTimeUsage: boolean;
  supportsSftp: boolean;
  supportsWebhookNotification: boolean;
  maxBatchSize: number;
}
```

适配器声明自身能力集，核心层根据能力动态决定执行策略（如：不支持预约变更时，本地调度器代替）。

---

## 7. 报表接口

权限：`reports.usage`。范围参数：`resellerId`（platform）、`enterpriseId`（与 JWT 范围校验，规则同 OpenAPI）。

### 7.0 SIM 汇总（状态 / 企业 / 拜访地 MCC）

```
GET /v1/reports/sim-summary?resellerId={}&enterpriseId={}&startDate={}&endDate={}
```

**Response**:
```json
{
  "total": 0,
  "byStatus": [{ "status": "ACTIVATED", "count": 0 }],
  "byEnterprise": [{ "enterpriseId": "uuid|null", "enterpriseName": "string|null", "count": 0 }],
  "byVisitedMcc": [{ "mcc": "460", "count": 0 }],
  "visitedMccWindow": { "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD" }
}
```

- `byStatus`：`INVENTORY | TEST_READY | ACTIVATED | DEACTIVATED | RETIRED`  
- `byEnterprise`：reseller/platform **未**指定单企业时填充；指定 `enterpriseId` / customer 时为 `[]`  
- `byVisitedMcc`：**拜访地网络 MCC**（`usage_daily_summary.visited_mccmnc` 前 3 位），表示用量发生国/网络；**不是** SIM 归属运营商 MCC。计数为窗口内有用量的**去重 SIM 数**  
- `startDate`/`endDate`：可选，约束拜访地窗口；默认近 6 个自然月；传入时跨度 ≤**36** 个自然月  
- Reseller 范围含 `reseller_id` 库存卡 + 下属企业 SIM

### 7.1 用量趋势

```
GET /v1/reports/usage-trend?enterpriseId={}&resellerId={}&startDate={}&endDate={}&granularity=day|month&groupBy=enterprise|mcc
```

- 不传 `groupBy`：`items[{ period, totalMb }]`  
- `groupBy=enterprise`：按 `enterprise_id`（reseller/platform；勿带 enterpriseId；customer **403**）  
- `groupBy=mcc`：MCC = `visited_mccmnc` 前 3 位数字；`items` 含 `groupKey` / `groupLabel`  
- 时间窗：一律 ≤36 个自然月；另 `granularity=day` ≤90 天；`month` ≤36 个自然月  
- **数据源（granularity=month）**：完整过往自然月 → `usage_monthly_summary`；当月/残月 → `usage_daily_summary` 现算。`granularity=day` 始终读日表。  
- 月表由 `USAGE_MONTHLY_ROLLUP` / 日表变更触发刷新，**与出账解耦**；不含套餐配额累计。  

### 7.2 Top SIM 排行

```
GET /v1/reports/top-sims?enterpriseId={}&resellerId={}&startDate={}&endDate={}&page={}&pageSize={}
```

- `startDate`/`endDate` 必填，跨度 ≤36 个自然月  

### 7.3 异常 SIM 报告

```
GET /v1/reports/anomaly-sims?enterpriseId={}&resellerId={}&startDate={}&endDate={}&page={}&pageSize={}
```

- `startDate`/`endDate` 必填，跨度 ≤36 个自然月  

### 7.4 停机原因分布

```
GET /v1/reports/deactivation-reasons?enterpriseId={}&resellerId={}&startDate={}&endDate={}
```

- `startDate`/`endDate` 必填，跨度 ≤36 个自然月  

---

## 8. 通用集成规范

### 8.1 北向 API 规范
- RESTful HTTPS JSON
- OpenAPI 3.0 文档
- URI 版本化 `/v1/...`
- TLS 1.2+

### 8.2 认证
- API Key（M2M）: `X-API-Key: <key>`
- OAuth2/OIDC（Web/第三方）: `Authorization: Bearer <token>`

### 8.3 Rate Limiting
- Token Bucket 算法
- 按租户 + 接口粒度
- 超限: `429 Too Many Requests` + `Retry-After` header

### 8.4 幂等
- 南向指令: `idempotencyKey` header
- SFTP 话单: `fileId + checksum` 去重
- 事件消费: `eventId` 幂等

### 8.5 重试策略
- 指数退避: `delay = baseDelay × 2^(attempt-1)`
- 最大重试: 3 次
- 最大延迟: 30 秒

---

## 9. Alert Configurations（US9）

**Clarifications 真源**: [alert-type-catalog.md](../clarifications/alert-type-catalog.md)、[alert-rule-config.md](../clarifications/alert-rule-config.md)

Phase 44 将告警实例查询与告警配置管理拆分为两个 Swagger 模块：

- **Alerts**：只处理已产生的告警实例，包含 `GET /v1/alerts`、`GET /v1/alerts:csv`、`GET /v1/alerts/{alertId}`、`POST /v1/alerts/{alertId}:acknowledge`、`GET /v1/alerts/summary`、`GET /v1/alerts/trends`。
- **Alert Configurations**：管理 `alert_type_catalog`、`alert_config_profiles`、`alert_config_items` 三表配置模型。

### 9.1 告警类型目录

```text
GET /v1/alert-types
PATCH /v1/alert-types/{alertType}
```

- **GET**：platform/reseller 可读；用于查看 7 个 canonical `alertType`、allowed scope、默认 severity/threshold/window/suppress/delivery 与说明；查询单个目录项使用 `alertType` 查询参数，不再在 Swagger UI 暴露重复的 `GET /v1/alert-types/{alertType}`。
- **PATCH**：platform-only；可维护目录项的默认配置、启用状态、可配置 scope、说明与排序。Swagger UI 中 path `alertType` 仅作为兼容占位，实际目标以 request body `alertType` 为准。不得仅通过目录 API 新增未实现 evaluator 算法的告警类型。

### 9.2 告警配置表对象与明细

```text
GET /v1/alert-config-profiles
POST /v1/alert-config-profiles?scopeType=&resellerId=&enterpriseId=
GET /v1/alert-config-profiles/{profileId}
PUT /v1/alert-config-profiles/{profileId}?scopeType=&resellerId=&enterpriseId=
GET /v1/alert-config-profiles/effective?alertType=&resellerId=&enterpriseId=
```

- **权限**：platform 可管理 PLATFORM / RESELLER / ENTERPRISE profile；reseller 只能管理自身 RESELLER profile 或下属 ENTERPRISE profile；enterprise/customer token 不允许访问 Alert Configurations 模块的任何接口，包括 catalog、profile list/detail、整表创建/更新与 effective 调试接口。
- **唯一性**：同一 PLATFORM、同一 RESELLER、同一 ENTERPRISE 同时最多一份 `ACTIVE` profile；同一 profile 下 `alertType` 唯一。
- **整表读写**：`GET /alert-config-profiles/{profileId}` 返回 profile 基本信息与全部 items；`POST /alert-config-profiles` 与 `PUT /alert-config-profiles/{profileId}` 通过 query 参数独立提交 `scopeType`、`resellerId`、`enterpriseId`，请求体一次性提交 profile 元数据和该 scope 允许的全部 alert items，系统校验后同时写入 `alert_config_profiles` 与 `alert_config_items`。
- **scope query 规则**：`scopeType=ENTERPRISE` 必须提供匹配的 `enterpriseId` 与 `resellerId`；`scopeType=RESELLER` 必须提供 `resellerId` 且 `enterpriseId` 为空；reseller admin token 只能写自身 `resellerId`；`scopeType=PLATFORM` 不接受 `resellerId` / `enterpriseId`。
- **列表筛选校验**：`GET /alert-config-profiles` 对 `resellerId`、`enterpriseId` 同样执行租户存在性与归属校验；reseller token 下 `resellerId` 必须匹配 token，`enterpriseId` 必须属于该 reseller；platform/admin key 或 admin token 下，若同时提供 `resellerId` 与 `enterpriseId`，二者必须构成有效父子关系。
- **effective 入参校验**：`GET /alert-config-profiles/effective` 对 `resellerId`、`enterpriseId` 执行同样的租户存在性与归属校验；reseller token 下 `resellerId` 必须匹配 token、`enterpriseId` 必须属于该 reseller；platform/admin key 或 admin token 查询企业级 effective 时必须同时提供匹配的 `resellerId` 与 `enterpriseId`。
- **allowed scope**：写入 items 时必须校验 `alert_type_catalog.allowed_scope_types`；ENTERPRISE profile 不接受 `CDR_DELAY`、`UPSTREAM_DISCONNECT`、`WEBHOOK_DELIVERY_FAILED`。
- **事务语义**：整表创建/更新必须避免半写入；profile 写入和 items 写入应在同一事务语义下完成，必要时通过 Supabase RPC / SQL function 实现。
- **effective 解析**：支持 ENTERPRISE scope 的告警按 ENTERPRISE → RESELLER → PLATFORM → built-in fallback 顺序返回最终生效项；Reseller-level 告警按 RESELLER → PLATFORM → built-in fallback；更具体 scope 的 `enabled=false` 阻断上层配置。
- **投递通道语义**：`delivery_channels` 目前支持 `PORTAL` 与 `WEBHOOK`。`PORTAL` 表示告警写入 `alerts` 后由 Portal / Alerts API 查询展示，同时在 `alert_deliveries` 记录 `channel=PORTAL`、`status=DELIVERED`、`target=portal`。`WEBHOOK` 表示告警触发后允许系统生成 `ALERT_TRIGGERED` 事件并匹配 `webhook_subscriptions` 发送到客户下游 HTTPS webhook；若 `delivery_channels` 不包含 `WEBHOOK`，系统仍记录告警与事件，但不得向客户系统发送 webhook。
- **WEBHOOK 投递流程**：首次投递不是先写 `jobs` 再由 worker 发送；当前实现是在新告警创建链路中写入 `events` 与 `webhook_deliveries` 后立即尝试第一次 HTTP POST。失败时 `webhook_deliveries` 保持 `PENDING` 并设置 `next_retry_at`；worker 定时创建并处理 `WEBHOOK_DELIVERY` job，从到期的 `webhook_deliveries` 读取任务并执行重试。重试耗尽后可触发 `WEBHOOK_DELIVERY_FAILED` 告警。

旧 item 级接口不再作为契约入口。由于没有旧客户端需要兼容，后端路由与 Swagger UI 均应移除：

```text
GET /v1/alert-config-profiles/{profileId}/items
PUT /v1/alert-config-profiles/{profileId}/items/{alertType}
PATCH /v1/alert-config-profiles/{profileId}/items/{alertType}
```

旧 `/v1/alert-configs` 单表接口属于 Phase 43 兼容入口，Phase 44 后在 OpenAPI 中标记 deprecated，不再作为新增功能入口。

