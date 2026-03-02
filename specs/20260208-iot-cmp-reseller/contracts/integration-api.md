# API 契约：集成、事件与可观测性

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08
**关联 User Story**: US8（上游对账）、US9（监控诊断）、US10（虚拟化层）、US11（事件架构）
**关联需求**: FR-035 ~ FR-039

---

## 1. 连接状态与诊断

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

**说明**: 数据通过上游供应商 API 代理获取（非信令级直连）

### 1.2 重置连接

```
POST /v1/sims/{simId}:reset-connection
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
  "message": "Connection reset request submitted"
}
```

### 1.3 查询 SIM 定位

```
GET /v1/sims/{simId}/location
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

### 1.4 查询 SIM 位置历史

```
GET /v1/sims/{simId}/location-history?from={from}&to={to}&page={}&pageSize={}
```

**权限**: 代理商管理员（敏感数据，需审计）

---

## 2. 告警管理

### 2.1 查询告警列表

```
GET /v1/alerts?enterpriseId={}&alertType={}&from={}&to={}&acknowledged={}&page={}&pageSize={}
```

**权限**: 代理商角色 | 企业角色

**Query Parameters**:
| 参数 | 类型 | 说明 |
|------|------|------|
| enterpriseId | uuid | 企业筛选 |
| alertType | string | POOL_USAGE_HIGH / OUT_OF_PROFILE_SURGE / SILENT_SIM / UNEXPECTED_ROAMING / CDR_DELAY / UPSTREAM_DISCONNECT |
| from / to | datetime | 时间范围 |
| acknowledged | boolean | 是否已确认 |

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
  "total": 25
}
```

**告警去重键**: `resellerId + simId + alertType + windowStart`
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
  "total": 1200,
  "bySeverity": { "P0": 2, "P1": 18, "P2": 240, "P3": 940 },
  "byType": { "API_AVAILABILITY": 6, "QUOTA_EXHAUSTED": 12 }
}
```

### 2.4 告警趋势

```
GET /v1/alerts/trends?from={}&to={}&bucket=hour&alertType={}
```

**Response 200**:
```json
{
  "buckets": [
    { "ts": "2026-02-08T10:00:00Z", "count": 12 },
    { "ts": "2026-02-08T11:00:00Z", "count": 8 }
  ]
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

**出站签名校验**:
- 使用订阅 `secret` 对原始 HTTP body 字符串进行 HMAC-SHA256 计算
- Header `X-Webhook-Signature` 固定为 `sha256=<hex>` 形式
- 接收方应使用原始 body（不做 JSON 重排）计算并比较签名

**重放保护**: 接收方应验证 `X-Webhook-Timestamp` 在 5 分钟内

**投递重试**: 指数退避（2s, 4s, 8s），至少 3 次，最终失败进入死信队列

### 3.3 查询 Webhook 投递记录

```
GET /v1/webhook-subscriptions/{subscriptionId}/deliveries?status={}&page={}&pageSize={}
```

### 3.4 重试投递

```
POST /v1/webhook-deliveries/{deliveryId}:retry
```

---

## 4. 事件查询

### 4.1 查询事件列表

```
GET /v1/events?eventType={}&resellerId={}&simId={}&from={}&to={}&page={}&pageSize={}
```

**权限**: 系统管理员 | 代理商管理员

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
| `SIM_STATUS_CHANGED` | SIM 状态变更 | simId, iccid, beforeStatus, afterStatus, supplierId | resellerId+simId+afterStatus+occurredAt(1min) |
| `SUBSCRIPTION_CHANGED` | 订阅创建/变更/退订 | subscriptionId, simId, packageId, beforeState, afterState, effectiveAt | resellerId+subscriptionId+afterState+effectiveAt |
| `BILL_PUBLISHED` | 账单发布 | billId, customerId, period, totalAmount, dueDate | customerId+billId |
| `PAYMENT_CONFIRMED` | 支付确认 | billId, customerId, paidAmount, paidAt, paymentRef | customerId+billId+paymentRef |
| `ALERT_TRIGGERED` | 告警触发 | alertType, customerId, simId, threshold, currentValue, windowStart | resellerId+simId+alertType+windowStart |
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

### 7.1 用量趋势

```
GET /v1/reports/usage-trend?enterpriseId={}&period={}&granularity={}
```

### 7.2 Top SIM 排行

```
GET /v1/reports/top-sims?enterpriseId={}&period={}&limit={}
```

### 7.3 异常 SIM 报告

```
GET /v1/reports/anomaly-sims?enterpriseId={}&period={}
```

### 7.4 停机原因分布

```
GET /v1/reports/deactivation-reasons?enterpriseId={}&period={}
```

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
